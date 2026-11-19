package iothub

import (
	"net/url"
	"strings"
	"testing"
)

// TestBuildPublishTopic_SystemPropertiesLiteral pins the documented MQTT form
// for the content type / encoding system properties (MG-68): the `$.ct` /
// `$.ce` keys stay literal and only the values are URL-encoded.
func TestBuildPublishTopic_SystemPropertiesLiteral(t *testing.T) {
	topic := buildPublishTopic("meatgeek3", map[string]string{
		MessageIDPropertyName:       "abc123",
		ContentTypePropertyName:     ContentTypeJSON,
		ContentEncodingPropertyName: ContentEncodingUTF8,
	})

	if !strings.HasPrefix(topic, "devices/meatgeek3/messages/events/") {
		t.Fatalf("topic has wrong prefix: %q", topic)
	}
	for _, want := range []string{"$.ct=application%2Fjson", "$.ce=utf-8", "messageId=abc123"} {
		if !strings.Contains(topic, want) {
			t.Errorf("topic %q must contain %q", topic, want)
		}
	}
	if strings.Contains(topic, "%24") {
		t.Errorf("system property keys must not be percent-encoded: %q", topic)
	}
}

// TestBuildPublishTopic_ApplicationValuesStillEncoded guards that application
// property values (and keys) are still URL-encoded, so a correlation id
// carrying `&` or `=` cannot split or forge a property.
func TestBuildPublishTopic_ApplicationValuesStillEncoded(t *testing.T) {
	corr := "a&b=c d/e"
	topic := buildPublishTopic("dev", map[string]string{
		CorrelationIDPropertyName:   corr,
		ContentTypePropertyName:     ContentTypeJSON,
		ContentEncodingPropertyName: ContentEncodingUTF8,
	})

	want := "correlation.id=" + url.QueryEscape(corr)
	if !strings.Contains(topic, want) {
		t.Errorf("topic %q must contain encoded correlation %q", topic, want)
	}
	if strings.Contains(topic, corr) {
		t.Errorf("raw correlation value leaked unencoded into topic: %q", topic)
	}

	// Parse the property bag back: exactly three pairs, values round-trip.
	bag := strings.TrimPrefix(topic, "devices/dev/messages/events/")
	parsed, err := url.ParseQuery(bag)
	if err != nil {
		t.Fatalf("property bag does not parse: %v", err)
	}
	if len(parsed) != 3 {
		t.Errorf("expected 3 properties, got %d: %v", len(parsed), parsed)
	}
	if got := parsed.Get(CorrelationIDPropertyName); got != corr {
		t.Errorf("correlation.id round-trip = %q, want %q", got, corr)
	}
	if got := parsed.Get(ContentTypePropertyName); got != ContentTypeJSON {
		t.Errorf("$.ct round-trip = %q, want %q", got, ContentTypeJSON)
	}

	// Application keys are encoded too.
	if got := buildPublishTopic("dev", map[string]string{"a b": "x"}); !strings.HasSuffix(got, "/a+b=x") {
		t.Errorf("application key must be URL-encoded; got %q", got)
	}
}

func TestBuildPublishTopic_EmptyAndDeterministic(t *testing.T) {
	if got := buildPublishTopic("dev", nil); got != "devices/dev/messages/events/" {
		t.Errorf("empty properties topic = %q", got)
	}
	props := map[string]string{"messageId": "m", "$.ct": ContentTypeJSON, "$.ce": ContentEncodingUTF8, "traceparent": "00-x"}
	first := buildPublishTopic("dev", props)
	for i := 0; i < 20; i++ {
		if got := buildPublishTopic("dev", props); got != first {
			t.Fatalf("topic not deterministic: %q vs %q", got, first)
		}
	}
}
