package runtime

import (
	"encoding/json"
	"errors"
	"fmt"
)

const (
	codeUnknownMethod = "unknown_method"
	codePluginError   = "plugin_error"
	codePluginPanic   = "plugin_panic"
)

var emptyResult = struct{}{}

func okEnvelope(result any) ([]byte, error) {
	encoded, err := json.Marshal(result)
	if err != nil {
		return nil, fmt.Errorf("encode result: %w", err)
	}
	return json.Marshal(Envelope{OK: true, Result: encoded})
}

func errorEnvelope(code, message string) []byte {
	raw, err := json.Marshal(Envelope{OK: false, Error: &EnvelopeError{Code: code, Message: message}})
	if err != nil {
		return []byte(`{"ok":false,"error":{"code":"internal","message":"failed to encode error"}}`)
	}
	return raw
}

func unwrapEnvelope(raw []byte, out any) error {
	if len(raw) == 0 {
		return errors.New("empty host response")
	}
	var env Envelope
	if err := json.Unmarshal(raw, &env); err != nil {
		return fmt.Errorf("decode host envelope: %w", err)
	}
	if !env.OK {
		if env.Error != nil {
			return fmt.Errorf("host error %s: %s", env.Error.Code, env.Error.Message)
		}
		return errors.New("host reported failure")
	}
	if out == nil || len(env.Result) == 0 {
		return nil
	}
	return json.Unmarshal(env.Result, out)
}
