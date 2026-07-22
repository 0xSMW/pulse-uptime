package interactive

import (
	"strings"
	"testing"
)

func TestParseCatalogPresetsScopeSelectionShape(t *testing.T) {
	raw := []byte(`{"data":{"categories":[{"category":"db","presets":[
		{"id":"neon","name":"Neon","provider":"Neon","installed":false,"installedScopeIds":["a"],
		 "scopeSelection":{"required":true,"allowsUnscoped":false,"status":"static","options":[
			{"id":"a","label":"Region A","available":true},
			{"id":"b","label":"Region B","available":false}]}}]}]}}`)
	presets := parseCatalogPresets(raw)
	if len(presets) != 1 {
		t.Fatalf("got %d presets, want 1", len(presets))
	}
	preset := presets[0]
	if !preset.ScopeRequired {
		t.Fatal("scopeSelection.required not honored")
	}
	if len(preset.ScopeOptions) != 2 || preset.ScopeOptions[1].Available {
		t.Fatalf("unexpected scope options %+v", preset.ScopeOptions)
	}
	if !preset.Enabled {
		t.Fatal("missing enabled flag must default to enabled")
	}
}

func TestParseCatalogPresetsGatingFields(t *testing.T) {
	raw := []byte(`{"data":{"categories":[{"category":"ai","presets":[
		{"id":"off","name":"Off","provider":"P","enabled":false},
		{"id":"broken","name":"Broken","provider":"P","enabled":true,"hasValidationError":true}]}]}}`)
	presets := parseCatalogPresets(raw)
	if len(presets) != 2 {
		t.Fatalf("got %d presets, want 2", len(presets))
	}
	if presets[0].Enabled {
		t.Fatal("enabled false not parsed")
	}
	if !presets[1].HasValidationError {
		t.Fatal("hasValidationError not parsed")
	}
}

func TestParseCatalogPresetsScopeSelectionFullyDecides(t *testing.T) {
	raw := []byte(`{"data":{"categories":[{"category":"db","presets":[
		{"id":"neon","name":"Neon","provider":"Neon",
		 "scopeSelection":{"required":false,"allowsUnscoped":true,"status":"ready","options":[]},
		 "scope":{"kind":"required_options","options":[{"id":"a","label":"Region A"}]}}]}]}}`)
	presets := parseCatalogPresets(raw)
	if len(presets) != 1 {
		t.Fatalf("got %d presets, want 1", len(presets))
	}
	if presets[0].ScopeRequired {
		t.Fatal("legacy scope shape must not override a present scopeSelection")
	}
	if len(presets[0].ScopeOptions) != 0 {
		t.Fatalf("legacy options leaked past scopeSelection: %+v", presets[0].ScopeOptions)
	}
}

func TestParseCatalogPresetsLegacyScopeShape(t *testing.T) {
	raw := []byte(`{"data":{"categories":[{"category":"db","presets":[
		{"id":"neon","name":"Neon","provider":"Neon","scope":{"kind":"required_options","options":[{"id":"a","label":"Region A"}]}},
		{"id":"upstash","name":"Upstash","provider":"Upstash","scope":{"kind":"discovered_children","required":true}},
		{"id":"global","name":"Global","provider":"Upstash","scope":{"kind":"discovered_children","required":false}}]}]}}`)
	presets := parseCatalogPresets(raw)
	if len(presets) != 3 {
		t.Fatalf("got %d presets, want 3", len(presets))
	}
	if !presets[0].ScopeRequired {
		t.Fatal("required_options kind must require a scope")
	}
	if len(presets[0].ScopeOptions) != 1 || !presets[0].ScopeOptions[0].Available {
		t.Fatalf("legacy options must default to available, got %+v", presets[0].ScopeOptions)
	}
	if !presets[1].ScopeRequired {
		t.Fatal("required discovered scope not honored")
	}
	if presets[2].ScopeRequired {
		t.Fatal("optional discovered scope must not require one")
	}
}

func TestParseCatalogPresetsTopLevelCategories(t *testing.T) {
	raw := []byte(`{"categories":[{"category":"ai","presets":[{"id":"x","name":"X","provider":"P"}]}]}`)
	if presets := parseCatalogPresets(raw); len(presets) != 1 {
		t.Fatalf("got %d presets, want 1", len(presets))
	}
}

func TestInstallablePresetsSkipRules(t *testing.T) {
	presets := []catalogPreset{
		{ID: "installed_unscoped", Enabled: true, Installed: true},
		{ID: "fresh_unscoped", Enabled: true},
		{ID: "disabled", Enabled: false},
		{ID: "validation_error", Enabled: true, HasValidationError: true},
		{ID: "scoped_all_taken", Enabled: true, ScopeRequired: true, InstalledScopeIDs: []string{"a"}, ScopeOptions: []catalogScopeOption{{ID: "a", Label: "A", Available: true}}},
		{ID: "scoped_all_unavailable", Enabled: true, ScopeRequired: true, ScopeOptions: []catalogScopeOption{{ID: "a", Label: "A", Available: false}}},
		{ID: "scoped_open", Enabled: true, ScopeRequired: true, InstalledScopeIDs: []string{"a"}, ScopeOptions: []catalogScopeOption{{ID: "a", Label: "A", Available: true}, {ID: "b", Label: "B", Available: true}}},
		{ID: "scoped_discovery_pending", Enabled: true, ScopeRequired: true},
	}
	result := installablePresets(presets)
	got := make([]string, 0, len(result))
	for _, preset := range result {
		got = append(got, preset.ID)
	}
	want := "fresh_unscoped scoped_open"
	if strings.Join(got, " ") != want {
		t.Fatalf("installable presets %v, want %q", got, want)
	}
}

func TestInstallableScopeOptionsSanitizesLabels(t *testing.T) {
	preset := catalogPreset{ScopeRequired: true, ScopeOptions: []catalogScopeOption{{ID: "r1", Label: "Bad\x1b[31mregion", Available: true}}}
	options := installableScopeOptions(preset)
	if len(options) != 1 {
		t.Fatalf("got %d options, want 1", len(options))
	}
	if options[0].Value != "r1" {
		t.Fatalf("value %q must keep the raw scope id", options[0].Value)
	}
	if got := options[0].Label; !strings.Contains(got, `\x1b`) || strings.Contains(got, "\x1b") {
		t.Fatalf("label %q not sanitized", got)
	}
}
