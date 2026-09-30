package webdav

import (
	"context"
	"encoding/xml"
	"fmt"
	"io"
	"net/http"
	"time"

	corev1 "k8s.io/api/core/v1"
)

// CheckProtocol verifies authenticated WebDAV semantics without modifying data.
func CheckProtocol(ctx context.Context, secret *corev1.Secret, address string) error {
	username, password := string(secret.Data["probe-username"]), string(secret.Data["probe-password"])
	if username == "" || password == "" {
		return fmt.Errorf("probe credentials are missing")
	}
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, "PROPFIND", address, nil)
	if err != nil {
		return err
	}
	req.SetBasicAuth(username, password)
	req.Header.Set("Depth", "0")
	client := &http.Client{Timeout: 5 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	response, err := client.Do(req)
	if err != nil {
		return fmt.Errorf("WebDAV protocol probe failed")
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusMultiStatus {
		return fmt.Errorf("WebDAV probe returned %d", response.StatusCode)
	}
	var document struct {
		XMLName xml.Name `xml:"DAV: multistatus"`
	}
	if err := xml.NewDecoder(io.LimitReader(response.Body, 64<<10)).Decode(&document); err != nil {
		return fmt.Errorf("invalid WebDAV multistatus")
	}
	return nil
}
