// render is an offline development tool, not a cluster provisioner.
package main

import (
	"bytes"
	"flag"
	"fmt"
	"io"
	"os"

	"github.com/expbuild/expbuild/operator/internal/bazelremote"
	"github.com/expbuild/expbuild/operator/internal/instance"
	"sigs.k8s.io/yaml"
)

func run(r io.Reader, w io.Writer) error {
	data, err := io.ReadAll(io.LimitReader(r, 1<<20+1))
	if err != nil {
		return err
	}
	if len(data) > 1<<20 {
		return fmt.Errorf("input exceeds 1 MiB")
	}
	var c instance.Config
	if err = yaml.UnmarshalStrict(data, &c); err != nil {
		return err
	}
	objects, err := bazelremote.Render(c)
	if err != nil {
		return err
	}
	var output bytes.Buffer
	for _, obj := range objects {
		b, err := yaml.Marshal(obj)
		if err != nil {
			return err
		}
		output.WriteString("---\n")
		output.Write(b)
	}
	_, err = w.Write(output.Bytes())
	return err
}

func main() {
	path := flag.String("f", "", "trusted renderer input YAML (required)")
	flag.Parse()
	if *path == "" {
		fmt.Fprintln(os.Stderr, "-f is required")
		os.Exit(2)
	}
	f, err := os.Open(*path)
	if err == nil {
		defer f.Close()
		err = run(f, os.Stdout)
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
