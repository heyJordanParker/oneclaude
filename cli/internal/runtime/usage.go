package runtime

import (
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
}

// totals name the Usage table's last row for each breakdown.
var totals = map[string]string{"account": "All accounts", "model": "All models", "agent": "All agents", "project": "All projects", "day": "All days"}

const (
	chartDays       = 30
	notRecorded     = "Not recorded"
	removedAccounts = "Removed accounts"
)

// UsageTable is the Usage section of the pane and the dashboard: one row per
// account, model, agent type, project or day of a period, at API list prices.
// Rows run from the largest in the chosen units, or newest first by day.
// Since is the log's first day when the period starts before it. Days is the
// last 30 days, oldest first, each split the same way, or by account for a
// table by day.
type UsageTable struct {
	Today string     `json:"today"`
	Since string     `json:"since,omitempty"`
	Rows  []UsageRow `json:"rows"`
	Total UsageRow   `json:"total"`
	Days  []UsageDay `json:"days"`
}

// UsageRow is one row of the table. Key is empty for requests whose agent
// type or project was not recorded: those from before oneclaude recorded
// them, and those with no Claude Code session.
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
		span = periods["today"]
	}
	if _, ok := totals[by]; !ok {
		by = "account"
	}
	chartBy := by
	if by == "day" {
		chartBy = "account"
	}
	today := p.now().In(time.Local)
	covered := map[string]bool{}
	for i := 0; i < span.days; i++ {
		covered[today.AddDate(0, 0, span.from-i).Format(dayLayout)] = true
	}
	periodStart := today.AddDate(0, 0, span.from-span.days+1).Format(dayLayout)
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
	first := ""
	p.mu.Lock()
	for key, d := range p.history.days {
		if key.day < kept {
			delete(p.history.days, key)
			continue
		}
		if first == "" || key.day < first {
			first = key.day
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

	if span.days > 1 && first > periodStart {
		table.Since = first
	}
	table.Rows = labelled(rows, by)
	sort.Slice(table.Rows, func(i, j int) bool {
		a, b := table.Rows[i], table.Rows[j]
		if by == "day" {
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

// keyOf is the row a day's requests add up in. Accounts the proxy no longer
// holds add up as one row.
func keyOf(key dayKey, by string, names map[string]string) string {
	switch by {
	case "account":
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
// claude-opus-5-5, Main sessions for the sessions they talk to, and Oct 18
// for a day.
func labelOf(key, by string) string {
	switch {
	case by == "model":
		return model.Label(key)
	case by == "day":
		day, err := time.Parse(dayLayout, key)
		if err != nil {
			return key
		}
		return day.Format("Jan 2")
	case by == "agent" && key == "main":
		return "Main sessions"
	case key == "":
		return notRecorded
	default:
		return key
	}
}
