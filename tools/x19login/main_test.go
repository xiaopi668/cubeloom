package main

import (
	"encoding/json"
	"testing"
)

func TestNormalizeAccount(t *testing.T) {
	cases := map[string]string{
		"13800000000":       "13800000000",
		" 138 0000 0000 ":   "13800000000",
		"+86 138-0000-0000": "13800000000",
		"0086 13800000000":  "13800000000",
		"86 13800000000":    "13800000000",
		"+8613800000000":    "13800000000",
		"013800000000":      "13800000000",
		"a@b.com":           "a@b.com",
		" demo@163.com ":    "demo@163.com",
		"1380000000":        "1380000000", // 10 位：原样保留，由调用方报错
		"":                  "",
	}
	for in, want := range cases {
		if got := normalizeAccount(in); got != want {
			t.Fatalf("normalizeAccount(%q) = %q, want %q", in, got, want)
		}
	}
	if !isPhone11("13800000000") || isPhone11("1380000000") || isPhone11("23800000000") {
		t.Fatal("isPhone11 判定不对")
	}
}

func TestFlexUint64(t *testing.T) {
	var r loginRequest
	if err := json.Unmarshal([]byte(`{"entity_id":"874857176","token":"x"}`), &r); err != nil {
		t.Fatal(err)
	}
	if uint64(r.EntityID) != 874857176 {
		t.Fatalf("字符串 entity_id 解析失败: %d", r.EntityID)
	}
	if err := json.Unmarshal([]byte(`{"entity_id":123}`), &r); err != nil || uint64(r.EntityID) != 123 {
		t.Fatalf("数字 entity_id 解析失败: %v %d", err, r.EntityID)
	}
}
