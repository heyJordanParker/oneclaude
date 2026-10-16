package usage

import (
	"net/http"
	"testing"
	"time"
)

var now = time.Date(2026, 10, 15, 12, 0, 0, 0, time.UTC)

func TestWeeklyFromHeaders(t *testing.T) {
	h := http.Header{}
	h.Set("anthropic-ratelimit-unified-7d-utilization", "0.61")
	h.Set("anthropic-ratelimit-unified-7d-reset", "1792130400")
	w, ok := WeeklyFromHeaders(h, now)
	if !ok || w.Used != 0.61 || w.ResetsAt.Unix() != 1792130400 || w.Rejected {
		t.Fatalf("weekly = %+v %v", w, ok)
	}
	h.Set("anthropic-ratelimit-unified-7d-status", "rejected")
	if w, _ := WeeklyFromHeaders(h, now); !w.Rejected {
		t.Fatal("a rejected weekly window must read as rejected")
	}
}

func TestThrottleHasNoUnifiedHeaders(t *testing.T) {
	if HasUnified(http.Header{"X-Should-Retry": {"true"}}) {
		t.Fatal("a throttle 429 carries no unified headers")
	}
	h := http.Header{}
	h.Set("anthropic-ratelimit-unified-status", "rejected")
	if !QuotaRefused(h) {
		t.Fatal("a usage refusal says rejected")
	}
}

func TestWeeklyFromEndpoint(t *testing.T) {
	body := []byte(`{"five_hour":{"utilization":12,"resets_at":"2026-10-15T15:00:00Z"},"seven_day":{"utilization":58,"resets_at":"2026-10-17T09:00:00Z"}}`)
	w, ok := WeeklyFromEndpoint(body, now)
	if !ok || w.Used != 0.58 || !w.ResetsAt.Equal(time.Date(2026, 10, 17, 9, 0, 0, 0, time.UTC)) {
		t.Fatalf("weekly = %+v %v", w, ok)
	}
}

func TestWeeklyFromCodexReadsTheWindowThatLastsAWeek(t *testing.T) {
	body := []byte(`{"plan_type":"pro","rate_limit":{"allowed":true,"limit_reached":false,"primary_window":{"used_percent":40,"limit_window_seconds":18000,"reset_at":1792000000},"secondary_window":{"used_percent":23,"limit_window_seconds":604800,"reset_at":1792130400}}}`)
	w, ok := WeeklyFromCodex(body, now)
	if !ok || w.Used != 0.23 || w.ResetsAt.Unix() != 1792130400 || w.Rejected {
		t.Fatalf("weekly = %+v %v", w, ok)
	}
	pro := []byte(`{"rate_limit":{"allowed":false,"limit_reached":true,"primary_window":{"used_percent":100,"limit_window_seconds":604800,"reset_at":1792130400},"secondary_window":null}}`)
	if w, ok := WeeklyFromCodex(pro, now); !ok || w.Used != 1 || !w.Rejected {
		t.Fatalf("a weekly primary window = %+v %v", w, ok)
	}
	if _, ok := WeeklyFromCodex([]byte(`{"rate_limit":{"primary_window":{"used_percent":40,"limit_window_seconds":18000}}}`), now); ok {
		t.Fatal("a five-hour window is not a weekly reading")
	}
}

func TestPlanFromProfile(t *testing.T) {
	if got := PlanFromProfile([]byte(`{"organization":{"rate_limit_tier":"default_claude_max_20x"}}`)); got != "default_claude_max_20x" {
		t.Fatalf("plan = %q", got)
	}
}
