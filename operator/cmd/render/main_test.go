package main

import (
	"bytes"
	"strings"
	"testing"
)

func TestInvalidInputProducesNoManifest(t *testing.T) {
	for _, input := range []string{"name: first\nname: second\n", "unexpected: true\n", strings.Repeat("x", (1<<20)+1)} {
		var out bytes.Buffer
		if err := run(strings.NewReader(input), &out); err == nil {
			t.Fatal("invalid input accepted")
		}
		if out.Len() != 0 {
			t.Fatal("partial manifest emitted")
		}
	}
}
