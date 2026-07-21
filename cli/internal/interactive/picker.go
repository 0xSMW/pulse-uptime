package interactive

import (
	"context"
	"encoding/json"
	"fmt"

	"github.com/0xSMW/pulse-uptime/cli/internal/output"
)

// maxPickerOptions caps how many rows a picker offers so a hostile or huge
// listing cannot flood the terminal.
const maxPickerOptions = 200

// PickerSpec describes how to turn a list command into a select prompt.
type PickerSpec struct {
	Title  string
	List   []string
	ID     string
	Labels []string
}

// CollectOptions scans decoded JSON of any envelope shape and returns one
// option per object that carries both the id field and a nonempty label
// field. Objects missing a label are skipped so nested fragments such as
// affected-resource stubs never become picker rows. Order follows the
// document, duplicates by id collapse to the first occurrence. Every
// displayed string passes through output.SanitizeDisplay so server-supplied
// ESC, CR, newline, tab, or bidi bytes can never repaint the menu or forge
// confirm text. Option.Value keeps the raw id because it becomes argv, never
// rendered output.
func CollectOptions(raw []byte, idField string, labelFields []string) []Option {
	var doc any
	if err := json.Unmarshal(raw, &doc); err != nil {
		return nil
	}
	var options []Option
	seen := map[string]bool{}
	var walk func(node any)
	walk = func(node any) {
		if len(options) >= maxPickerOptions {
			return
		}
		switch v := node.(type) {
		case map[string]any:
			id, hasID := v[idField].(string)
			if hasID && id != "" && !seen[id] {
				for _, field := range labelFields {
					label, ok := v[field].(string)
					if !ok || label == "" {
						continue
					}
					seen[id] = true
					display := output.SanitizeDisplay(label)
					if label != id {
						display = fmt.Sprintf("%s (%s)", output.SanitizeDisplay(label), output.SanitizeDisplay(id))
					}
					options = append(options, Option{Label: display, Value: id})
					break
				}
			}
			for _, child := range v {
				walk(child)
			}
		case []any:
			for _, child := range v {
				walk(child)
			}
		}
	}
	walk(doc)
	return options
}

// pickEntity fetches the spec's listing and prompts for one entry. The
// returned label is the display row of the chosen entry for use in confirm
// prompts.
func pickEntity(ctx context.Context, env *Env, spec PickerSpec) (id, label string, err error) {
	raw, fetchErr := fetchJSON(ctx, env, spec.List)
	if fetchErr != nil {
		return "", "", fetchErr
	}
	options := CollectOptions(raw, spec.ID, spec.Labels)
	if len(options) == 0 {
		return "", "", fmt.Errorf("nothing to select, the listing is empty")
	}
	value, selectErr := env.UI.Select(spec.Title, "", options)
	if selectErr != nil {
		return "", "", selectErr
	}
	for _, option := range options {
		if option.Value == value {
			return value, option.Label, nil
		}
	}
	return value, value, nil
}
