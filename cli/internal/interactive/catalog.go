package interactive

import (
	"context"
	"encoding/json"
	"fmt"

	"github.com/0xSMW/pulse-uptime/cli/internal/output"
)

// catalogScopeOption is one selectable scope for a regional preset.
type catalogScopeOption struct {
	ID        string
	Label     string
	Available bool
}

// catalogPreset is the install-relevant slice of one catalog entry.
// ScopeRequired mirrors the REGION column rule the catalog table renders,
// an empty ScopeOptions on a required scope means discovery has not produced
// options yet and no install can succeed.
type catalogPreset struct {
	ID                 string
	Name               string
	Provider           string
	Enabled            bool
	HasValidationError bool
	Installed          bool
	InstalledScopeIDs  []string
	ScopeRequired      bool
	ScopeOptions       []catalogScopeOption
}

type rawScopeOption struct {
	ID        string `json:"id"`
	Label     string `json:"label"`
	Available *bool  `json:"available"`
}

type rawCatalogPreset struct {
	ID                 string   `json:"id"`
	Name               string   `json:"name"`
	Provider           string   `json:"provider"`
	Enabled            *bool    `json:"enabled"`
	HasValidationError bool     `json:"hasValidationError"`
	Installed          bool     `json:"installed"`
	InstalledScopeIDs  []string `json:"installedScopeIds"`
	Scope              *struct {
		Kind     string           `json:"kind"`
		Required bool             `json:"required"`
		Options  []rawScopeOption `json:"options"`
	} `json:"scope"`
	ScopeSelection *struct {
		Required bool             `json:"required"`
		Options  []rawScopeOption `json:"options"`
	} `json:"scopeSelection"`
}

type rawCatalogCategory struct {
	Presets []rawCatalogPreset `json:"presets"`
}

type rawCatalogDoc struct {
	Data struct {
		Categories []rawCatalogCategory `json:"categories"`
	} `json:"data"`
	Categories []rawCatalogCategory `json:"categories"`
}

// parseCatalogPresets flattens the catalog JSON into install-relevant
// presets. A present scopeSelection fully decides the scope model, the older
// scope shape is consulted only when scopeSelection is absent. A missing
// available flag counts as available and a missing enabled flag counts as
// enabled because older payloads omit them.
func parseCatalogPresets(raw []byte) []catalogPreset {
	var doc rawCatalogDoc
	if err := json.Unmarshal(raw, &doc); err != nil {
		return nil
	}
	categories := doc.Data.Categories
	if len(categories) == 0 {
		categories = doc.Categories
	}
	var presets []catalogPreset
	for _, category := range categories {
		for _, entry := range category.Presets {
			if entry.ID == "" {
				continue
			}
			preset := catalogPreset{
				ID:                 entry.ID,
				Name:               entry.Name,
				Provider:           entry.Provider,
				Enabled:            entry.Enabled == nil || *entry.Enabled,
				HasValidationError: entry.HasValidationError,
				Installed:          entry.Installed,
				InstalledScopeIDs:  entry.InstalledScopeIDs,
			}
			var options []rawScopeOption
			switch {
			case entry.ScopeSelection != nil:
				preset.ScopeRequired = entry.ScopeSelection.Required
				options = entry.ScopeSelection.Options
			case entry.Scope != nil:
				preset.ScopeRequired = entry.Scope.Kind == "required_options" || entry.Scope.Required
				options = entry.Scope.Options
			}
			for _, option := range options {
				available := option.Available == nil || *option.Available
				preset.ScopeOptions = append(preset.ScopeOptions, catalogScopeOption{ID: option.ID, Label: option.Label, Available: available})
			}
			presets = append(presets, preset)
		}
	}
	return presets
}

// installableScopeOptions returns the scopes an install can still target,
// excluding unavailable options and scopes already installed.
func installableScopeOptions(preset catalogPreset) []Option {
	installed := map[string]bool{}
	for _, id := range preset.InstalledScopeIDs {
		installed[id] = true
	}
	var options []Option
	for _, scope := range preset.ScopeOptions {
		if !scope.Available || installed[scope.ID] {
			continue
		}
		label := output.SanitizeDisplay(scope.Label)
		if scope.Label != scope.ID {
			label = fmt.Sprintf("%s (%s)", output.SanitizeDisplay(scope.Label), output.SanitizeDisplay(scope.ID))
		}
		options = append(options, Option{Label: label, Value: scope.ID})
	}
	return options
}

// installablePresets drops presets whose install is guaranteed to fail. The
// server rejects disabled presets and presets with a recorded validation
// error with PRESET_UNAVAILABLE. A non scoped flow reinstalls the same row,
// so any installed preset without a required scope is out. A required scope
// with no enumerated options means discovery is pending and the server
// rejects every typed value, so those are out too. A preset with an
// enumerated required scope stays only while an uninstalled available option
// remains.
func installablePresets(presets []catalogPreset) []catalogPreset {
	var result []catalogPreset
	for _, preset := range presets {
		if !preset.Enabled || preset.HasValidationError {
			continue
		}
		if !preset.ScopeRequired {
			if preset.Installed {
				continue
			}
			result = append(result, preset)
			continue
		}
		if len(installableScopeOptions(preset)) == 0 {
			continue
		}
		result = append(result, preset)
	}
	return result
}

// pickCatalogPreset fetches the catalog and prompts for an installable
// preset.
func pickCatalogPreset(ctx context.Context, env *Env) (catalogPreset, error) {
	raw, err := fetchJSON(ctx, env, []string{"dependency", "catalog"})
	if err != nil {
		return catalogPreset{}, err
	}
	parsed := parseCatalogPresets(raw)
	if len(parsed) == 0 {
		return catalogPreset{}, fmt.Errorf("the dependency catalog is unavailable or empty")
	}
	presets := installablePresets(parsed)
	if len(presets) == 0 {
		return catalogPreset{}, fmt.Errorf("every catalog preset is already installed")
	}
	options := make([]Option, 0, len(presets))
	byID := map[string]catalogPreset{}
	for _, preset := range presets {
		label := output.SanitizeDisplay(preset.Name)
		if preset.Provider != "" {
			label = fmt.Sprintf("%s (%s)", output.SanitizeDisplay(preset.Name), output.SanitizeDisplay(preset.Provider))
		}
		options = append(options, Option{Label: label, Value: preset.ID})
		byID[preset.ID] = preset
	}
	value, err := env.UI.Select("Select a catalog preset", "", options)
	if err != nil {
		return catalogPreset{}, err
	}
	return byID[value], nil
}

// buildDependencyInstall prompts for the scope when the preset requires one
// and returns the dependency add invocation. Both the add action and the
// browse flow share it so scope handling cannot drift between them.
func buildDependencyInstall(ctx context.Context, env *Env, preset catalogPreset) (*Invocation, error) {
	args := []string{"dependency", "add", preset.ID}
	if preset.ScopeRequired {
		scope, err := promptDependencyScope(env, preset)
		if err != nil {
			return nil, err
		}
		args = append(args, "--scope", scope)
	}
	notify, err := env.UI.Confirm("Enable notifications for this dependency?", "")
	if err != nil {
		return nil, err
	}
	if !notify {
		args = append(args, "--no-notifications")
	}
	return &Invocation{Args: args}, nil
}

// promptDependencyScope always selects from enumerated options because
// installablePresets never offers a required scope preset without any, the
// server rejects typed scopes while discovery is pending.
func promptDependencyScope(env *Env, preset catalogPreset) (string, error) {
	options := installableScopeOptions(preset)
	if len(options) == 0 {
		return "", fmt.Errorf("every scope for this preset is already installed")
	}
	title := fmt.Sprintf("Scope for %s", output.SanitizeDisplay(preset.Name))
	return env.UI.Select(title, "This preset requires a region or component.", options)
}
