package model

import (
	"math"
	"testing"
)

func near(a, b float64) bool { return math.Abs(a-b) < 1e-9 }

func TestARequestCostsWhatClaudeCodeSaysItCosts(t *testing.T) {
	cost := CostOf("claude-opus-5-5", Tokens{Input: 2, Output: 127, CacheWrite: 43544})
	if !near(cost.Input+cost.Output+cost.CacheRead+cost.CacheWrite, 0.3509) {
		t.Fatalf("cost = %+v, want $0.3509", cost)
	}
}

func TestAModelIsPricedWithoutItsDateOrContextSuffix(t *testing.T) {
	for _, id := range []string{"claude-haiku-4-5-20251001", "Claude-Haiku-4-5[1m]"} {
		if got := Canonical(id); got != "claude-haiku-4-5" {
			t.Errorf("Canonical(%q) = %q", id, got)
		}
	}
	if Canonical("claude-opus-5-5") == Canonical("claude-opus-5") {
		t.Fatal("Opus 5.5 and Opus 5 are priced apart")
	}
}

func TestHaikuPaysTheLongPriceOverAHundredThousandPromptTokens(t *testing.T) {
	short := CostOf("claude-haiku-5-5", Tokens{Input: 60_000, CacheRead: 40_000})
	long := CostOf("claude-haiku-5-5", Tokens{Input: 60_000, CacheRead: 40_001})
	if !near(short.Input, 0.006) || !near(long.Input, 0.03) {
		t.Fatalf("a 100,000-token prompt paid %v for input and one token more %v, want $0.006 and $0.03", short.Input, long.Input)
	}
}

func TestAnUnpricedModelCostsNothing(t *testing.T) {
	if cost := CostOf("claude-unreleased-9", Tokens{Input: 10}); cost != (Cost{}) {
		t.Fatalf("an unpriced model cost %+v", cost)
	}
}

func TestARequestLoggedWithoutItsModelCountsAsItsFamilysNewest(t *testing.T) {
	if got := ModelOf("", Opus); got != "claude-opus-5-5" {
		t.Fatalf("ModelOf = %q", got)
	}
	if got := ModelOf("claude-opus-5-20260101", Opus); got != "claude-opus-5" {
		t.Fatalf("ModelOf = %q", got)
	}
}
