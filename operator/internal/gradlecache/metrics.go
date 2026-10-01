package gradlecache

import (
	"fmt"
	"net/http"
	"time"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promhttp"
)

type cacheMetrics struct {
	handler      http.Handler
	requests     *prometheus.CounterVec
	duration     *prometheus.HistogramVec
	bytes        *prometheus.CounterVec
	evictions    prometheus.Counter
	evictedBytes prometheus.Counter
}

func newCacheMetrics(s *Server) *cacheMetrics {
	r := prometheus.NewRegistry()
	m := &cacheMetrics{
		requests:     prometheus.NewCounterVec(prometheus.CounterOpts{Name: "expbuild_cache_requests_total", Help: "Authenticated cache requests, excluding probes and metrics."}, []string{"method", "status_class"}),
		duration:     prometheus.NewHistogramVec(prometheus.HistogramOpts{Name: "expbuild_cache_request_duration_seconds", Help: "Cache request duration including transfer.", Buckets: []float64{.001, .005, .01, .05, .1, .5, 1, 5, 30}}, []string{"method"}),
		bytes:        prometheus.NewCounterVec(prometheus.CounterOpts{Name: "expbuild_cache_transfer_bytes_total", Help: "Bytes transferred by cache reads and upload bodies."}, []string{"direction"}),
		evictions:    prometheus.NewCounter(prometheus.CounterOpts{Name: "expbuild_cache_evictions_total", Help: "Entries removed by capacity eviction."}),
		evictedBytes: prometheus.NewCounter(prometheus.CounterOpts{Name: "expbuild_cache_evicted_bytes_total", Help: "Logical bytes removed by capacity eviction."}),
	}
	r.MustRegister(m.requests, m.duration, m.bytes, m.evictions, m.evictedBytes)
	for _, method := range []string{"GET", "PUT"} {
		for _, status := range []string{"2xx", "4xx", "5xx"} {
			m.requests.WithLabelValues(method, status)
		}
		m.duration.WithLabelValues(method)
	}
	for _, direction := range []string{"read", "write"} {
		m.bytes.WithLabelValues(direction)
	}
	for outcome, value := range map[string]func() float64{"hit": func() float64 { return float64(s.getHits.Load()) }, "miss": func() float64 { return float64(s.getMisses.Load()) }} {
		r.MustRegister(prometheus.NewCounterFunc(prometheus.CounterOpts{Name: "expbuild_cache_lookups_total", Help: "Cache GET lookup results; not build task hits.", ConstLabels: prometheus.Labels{"outcome": outcome}}, value))
	}
	r.MustRegister(prometheus.NewGaugeFunc(prometheus.GaugeOpts{Name: "expbuild_cache_used_bytes", Help: "Logical bytes of published cache entries."}, func() float64 { s.mu.Lock(); defer s.mu.Unlock(); return float64(s.used) }))
	r.MustRegister(prometheus.NewGaugeFunc(prometheus.GaugeOpts{Name: "expbuild_cache_capacity_bytes", Help: "Configured logical cache budget."}, func() float64 { return float64(s.maxTotal) }))
	r.MustRegister(prometheus.NewGaugeFunc(prometheus.GaugeOpts{Name: "expbuild_cache_entries", Help: "Published cache entries."}, func() float64 { s.mu.Lock(); defer s.mu.Unlock(); return float64(len(s.entries)) }))
	m.handler = promhttp.HandlerFor(r, promhttp.HandlerOpts{})
	return m
}

type measuredResponse struct {
	http.ResponseWriter
	status int
	bytes  int64
}

func (w *measuredResponse) WriteHeader(code int) {
	if w.status == 0 {
		w.status = code
		w.ResponseWriter.WriteHeader(code)
	}
}
func (w *measuredResponse) Write(p []byte) (int, error) {
	if w.status == 0 {
		w.WriteHeader(http.StatusOK)
	}
	n, err := w.ResponseWriter.Write(p)
	w.bytes += int64(n)
	return n, err
}
func (s *Server) measure(w http.ResponseWriter, r *http.Request, run func(http.ResponseWriter)) {
	started := time.Now()
	response := &measuredResponse{ResponseWriter: w}
	run(response)
	if response.status == 0 {
		response.status = http.StatusOK
	}
	s.metrics.requests.WithLabelValues(r.Method, fmt.Sprintf("%dxx", response.status/100)).Inc()
	s.metrics.duration.WithLabelValues(r.Method).Observe(time.Since(started).Seconds())
	if r.Method == http.MethodGet && response.status == http.StatusOK {
		s.metrics.bytes.WithLabelValues("read").Add(float64(response.bytes))
	}
}
