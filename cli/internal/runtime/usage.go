package runtime

import (
	"fmt"
	"slices"
	"sort"
	"time"

	"github.com/heyJordanParker/oneclaude/cli/internal/model"
)

// periods are the Usage table's periods: how many days back each starts,
// and how many days it covers.
var periods = map[string]struct{ from, days int }{
	"today":     {0, 1},
	"yesterday": {-1, 1},
	"week":      {0, 7},
	"month":     {0, 30},
	"quarter":   {0, daysKept},
}

// The time breakdown steps by the hour over one day, by the week over 90
// days, and by the day otherwise.
const (
	byTime = "time"
	byHour = "hour"
	byDay  = "day"
	byWeek = "week"
)

var breakdowns = []string{"account", "model", "agent", "project", byTime}

// totals name the Usage table's last row for each breakdown, and for each
// step of time.
var totals = map[string]string{"account": "All accounts", "model": "All models", "agent": "All agents", "project": "All projects", byHour: "All hours", byDay: "All days", byWeek: "All weeks"}

const (
	chartDays       = 30
	notRecorded     = "Not recorded"
	noAccount       = "No account recorded"
	removedAccounts = "Removed accounts"
)

// UsageTable is the Usage section of the Accounts tab and the dashboard: one row per
// account, model, agent type, project or step of time of a period, at API
// list prices. Rows run from the largest in the chosen units, or newest first
// by time. Days is the last 30 days, oldest first, each split the same way,
// or by account for a table by time.
type UsageTable struct {
	Today string     `json:"today"`
	Rows  []UsageRow `json:"rows"`
	Total UsageRow   `json:"total"`
	Days  []UsageDay `json:"days"`
}

// UsageRow is one row of the table. Key is empty for requests whose account,
// agent type or project was not recorded: those imported from transcripts,
// those from before oneclaude recorded agent types, and those with no Claude
// Code session.
type UsageRow struct {
	Key    string       `json:"key"`
	Label  string       `json:"label"`
	Tokens model.Tokens `json:"tokens"`
	Cost   model.Cost   `json:"cost"`
}

type UsageDay struct {
	Day  string     `json:"day"`
	Rows []UsageRow `json:"rows"`
}

// Usage adds up the request log for one period, split by one breakdown, and
// sorts it by "cost" or "tokens". Every account shows, with or without
// requests.
func (p *Plugin) Usage(period, by, units string) UsageTable {
	p.readRequestLog()
	span, ok := periods[period]
	if !ok {
		span = periods["month"]
	}
	isTime := by == byTime
	chartBy := by
	switch {
	case isTime:
		by, chartBy = stepOf(span.days), "account"
	case !slices.Contains(breakdowns, by):
		by, chartBy = "account", "account"
	}
	today := p.now().In(time.Local)
	covered := map[string]bool{}
	for i := 0; i < span.days; i++ {
		covered[today.AddDate(0, 0, span.from-i).Format(dayLayout)] = true
	}
	chartStart := today.AddDate(0, 0, 1-chartDays).Format(dayLayout)
	kept := today.AddDate(0, 0, 1-daysKept).Format(dayLayout)

	names := map[string]string{}
	for _, a := range p.accountList() {
		names[p.hash(a.ID)] = a.Name
	}
	table := UsageTable{Today: today.Format(dayLayout)}
	rows := map[string]*UsageRow{}
	if by == "account" {
		for _, name := range names {
			rows[name] = &UsageRow{Key: name}
		}
	}
	chart := map[string]map[string]*UsageRow{}
	p.mu.Lock()
	for key, d := range p.history.days {
		if key.day < kept {
			delete(p.history.days, key)
			continue
		}
		if covered[key.day] {
			rowFor(rows, keyOf(key, by, names)).add(d)
			table.Total.add(d)
		}
		if key.day >= chartStart {
			if chart[key.day] == nil {
				chart[key.day] = map[string]*UsageRow{}
			}
			rowFor(chart[key.day], keyOf(key, chartBy, names)).add(d)
		}
	}
	p.mu.Unlock()

	table.Rows = labelled(rows, by)
	sort.Slice(table.Rows, func(i, j int) bool {
		a, b := table.Rows[i], table.Rows[j]
		if isTime {
			return a.Key > b.Key
		}
		if x, y := a.amount(units), b.amount(units); x != y {
			return x > y
		}
		return a.Label < b.Label
	})
	table.Total.Label = totals[by]
	for i := chartDays - 1; i >= 0; i-- {
		day := today.AddDate(0, 0, -i).Format(dayLayout)
		table.Days = append(table.Days, UsageDay{Day: day, Rows: labelled(chart[day], chartBy)})
	}
	return table
}

func stepOf(days int) string {
	switch {
	case days == 1:
		return byHour
	case days > chartDays:
		return byWeek
	default:
		return byDay
	}
}

func rowFor(rows map[string]*UsageRow, key string) *UsageRow {
	row := rows[key]
	if row == nil {
		row = &UsageRow{Key: key}
		rows[key] = row
	}
	return row
}

func (r *UsageRow) add(d *dayUsage) {
	r.Tokens.Add(d.tokens)
	r.Cost.Add(d.cost)
}

func (r UsageRow) amount(units string) float64 {
	if units == "tokens" {
		t := r.Tokens
		return float64(t.Input + t.Output + t.CacheRead + t.CacheWrite)
	}
	c := r.Cost
	return c.Input + c.Output + c.CacheRead + c.CacheWrite
}

// keyOf is the row an hour's requests add up in. Accounts the proxy no longer
// holds add up as one row, and requests no account was recorded for as
// another. A step of time keys by its start, so keys sort by time.
func keyOf(key dayKey, by string, names map[string]string) string {
	switch by {
	case "account":
		if key.account == "" {
			return ""
		}
		if name, ok := names[key.account]; ok {
			return name
		}
		return removedAccounts
	case "model":
		return key.model
	case "agent":
		return key.agent
	case "project":
		return key.project
	case byHour:
		return fmt.Sprintf("%s %02d", key.day, key.hour)
	case byWeek:
		day, err := time.ParseInLocation(dayLayout, key.day, time.Local)
		if err != nil {
			return key.day
		}
		return day.AddDate(0, 0, -(int(day.Weekday())+6)%7).Format(dayLayout)
	default:
		return key.day
	}
}

func labelled(rows map[string]*UsageRow, by string) []UsageRow {
	out := make([]UsageRow, 0, len(rows))
	for _, row := range rows {
		row.Label = labelOf(row.Key, by)
		out = append(out, *row)
	}
	return out
}

// labelOf names a row as the person reads it: Opus 5.5 for
// claude-opus-5-5, Main sessions for the sessions they talk to, 17:00 for an
// hour, Oct 18 for a day, and Week of Oct 13 for the week that starts then.
func labelOf(key, by string) string {
	switch {
	case by == "model":
		return model.Label(key)
	case by == byHour && len(key) > len(dayLayout):
		return key[len(dayLayout)+1:] + ":00"
	case by == byDay || by == byWeek:
		day, err := time.Parse(dayLayout, key)
		if err != nil {
			return key
		}
		if by == byWeek {
			return day.Format("Week of Jan 2")
		}
		return day.Format("Jan 2")
	case by == "agent" && key == "main":
		return "Main sessions"
	case by == "account" && key == "":
		return noAccount
	case key == "":
		return notRecorded
	default:
		return key
	}
}
