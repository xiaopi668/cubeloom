package neteasex19

import (
	"encoding/json"
	"errors"
	"fmt"
	"strings"
)

// sauthField 是 sauth JSON 中的单个字段, Value 保存原始 JSON 值,
// 以便在字符串/数字/bool 之间原样透传 (官方 SDK 上报的字段类型并不统一)
type sauthField struct {
	Key   string
	Value json.RawMessage
}

// SauthCookie 表示一份网易登录态 (sauth_json)。
//
// 与普通 struct 不同, 这里显式保留字段的原始顺序与原始类型:
// 网易校验收到的 JSON 文本, 字段顺序或类型变化都可能导致登录失败,
// 因此解析后再序列化必须逐字节还原用户/上游给出的内容。
type SauthCookie struct {
	fields []sauthField
}

// NewSauthCookie 创建一个空的 sauth
func NewSauthCookie() *SauthCookie {
	return &SauthCookie{}
}

// ParseSauthCookie 解析 sauth。既接受裸 JSON:
//
//	{"gameid":"x19","sdkuid":"...","sessionid":"...", ...}
//
// 也接受启动器常见的包裹形式:
//
//	{"sauth_json":"{\"gameid\":\"x19\", ...}"}
func ParseSauthCookie(raw string) (*SauthCookie, error) {
	s := strings.TrimSpace(raw)
	if s == "" {
		return nil, errors.New("sauth 内容为空")
	}
	s = strings.TrimPrefix(s, "\ufeff")

	// 解开 {"sauth_json": "..."} 包裹
	if strings.HasPrefix(s, "{") && strings.Contains(s, `"sauth_json"`) {
		var wrapper struct {
			SauthJSON string `json:"sauth_json"`
		}
		if err := json.Unmarshal([]byte(s), &wrapper); err == nil {
			if inner := strings.TrimSpace(wrapper.SauthJSON); inner != "" {
				s = inner
			}
		}
	}

	dec := json.NewDecoder(strings.NewReader(s))
	dec.UseNumber()
	tok, err := dec.Token()
	if err != nil {
		return nil, fmt.Errorf("解析 sauth 失败: %w", err)
	}
	if d, ok := tok.(json.Delim); !ok || d != '{' {
		return nil, errors.New("解析 sauth 失败: 不是 JSON 对象")
	}

	cookie := NewSauthCookie()
	for dec.More() {
		keyTok, err := dec.Token()
		if err != nil {
			return nil, fmt.Errorf("解析 sauth 失败: %w", err)
		}
		key, ok := keyTok.(string)
		if !ok {
			return nil, errors.New("解析 sauth 失败: 字段名不是字符串")
		}
		var raw json.RawMessage
		if err := dec.Decode(&raw); err != nil {
			return nil, fmt.Errorf("解析 sauth 字段 %q 失败: %w", key, err)
		}
		cookie.setRaw(key, append(json.RawMessage(nil), raw...))
	}
	if len(cookie.fields) == 0 {
		return nil, errors.New("解析 sauth 失败: 没有字段")
	}
	return cookie, nil
}

// setRaw 按原顺序写入字段, 已存在则原地覆盖 (不改变位置)
func (c *SauthCookie) setRaw(key string, value json.RawMessage) {
	for i := range c.fields {
		if c.fields[i].Key == key {
			c.fields[i].Value = value
			return
		}
	}
	c.fields = append(c.fields, sauthField{Key: key, Value: value})
}

// setRawIfAbsent 仅在字段不存在时写入 (用于补齐默认字段而不覆盖用户值)
func (c *SauthCookie) setRawIfAbsent(key string, value json.RawMessage) {
	for i := range c.fields {
		if c.fields[i].Key == key {
			return
		}
	}
	c.fields = append(c.fields, sauthField{Key: key, Value: value})
}

// Set 写入一个字符串字段
func (c *SauthCookie) Set(key, value string) {
	b, err := json.Marshal(value)
	if err != nil {
		return
	}
	c.setRaw(key, b)
}

// SetIfAbsent 仅在字段不存在时写入字符串字段
func (c *SauthCookie) SetIfAbsent(key, value string) {
	b, err := json.Marshal(value)
	if err != nil {
		return
	}
	c.setRawIfAbsent(key, b)
}

// Get 读取字段。字符串字段返回其内容, 其它类型返回原始 JSON 文本。
func (c *SauthCookie) Get(key string) (string, bool) {
	for _, f := range c.fields {
		if f.Key != key {
			continue
		}
		var s string
		if err := json.Unmarshal(f.Value, &s); err == nil {
			return s, true
		}
		return string(f.Value), true
	}
	return "", false
}

// Has 判断字段是否存在
func (c *SauthCookie) Has(key string) bool {
	_, ok := c.Get(key)
	return ok
}

// Delete 删除字段
func (c *SauthCookie) Delete(key string) {
	for i := range c.fields {
		if c.fields[i].Key == key {
			c.fields = append(c.fields[:i], c.fields[i+1:]...)
			return
		}
	}
}

// Keys 按顺序返回全部字段名
func (c *SauthCookie) Keys() []string {
	out := make([]string, 0, len(c.fields))
	for _, f := range c.fields {
		out = append(out, f.Key)
	}
	return out
}

// Clone 深拷贝一份 sauth
func (c *SauthCookie) Clone() *SauthCookie {
	out := &SauthCookie{fields: make([]sauthField, 0, len(c.fields))}
	for _, f := range c.fields {
		out.fields = append(out.fields, sauthField{
			Key:   f.Key,
			Value: append(json.RawMessage(nil), f.Value...),
		})
	}
	return out
}

// JSON 输出紧凑的 sauth JSON (字段顺序与解析时一致)
func (c *SauthCookie) JSON() string {
	var b strings.Builder
	b.Grow(256)
	b.WriteByte('{')
	for i, f := range c.fields {
		if i > 0 {
			b.WriteByte(',')
		}
		key, err := json.Marshal(f.Key)
		if err != nil {
			continue
		}
		b.Write(key)
		b.WriteByte(':')
		b.Write(f.Value)
	}
	b.WriteByte('}')
	return b.String()
}

// String 实现 fmt.Stringer, 等价于 JSON()
func (c *SauthCookie) String() string { return c.JSON() }

// WrappedJSON 输出 x19 login-otp 需要的 {"sauth_json":"<cookie json>"} 包裹形式
func (c *SauthCookie) WrappedJSON() []byte {
	w := struct {
		SauthJSON string `json:"sauth_json"`
	}{SauthJSON: c.JSON()}
	b, err := json.Marshal(&w)
	if err != nil {
		panic(err)
	}
	return b
}

// SauthJSON 输出用于 authentication-otp 的 sauth_json:
// 与 JSON() 相同, 但当 platform 为 "ad" (安卓渠道) 时替换为 "pc"
func (c *SauthCookie) SauthJSON() string {
	if v, ok := c.Get("platform"); ok && v == "ad" {
		clone := c.Clone()
		clone.Set("platform", "pc")
		return clone.JSON()
	}
	return c.JSON()
}

// UDID 返回 udid 字段 (缺失时回退到 deviceid)
func (c *SauthCookie) UDID() string {
	if v, ok := c.Get("udid"); ok && v != "" {
		return v
	}
	if v, ok := c.Get("deviceid"); ok && v != "" {
		return v
	}
	return ""
}

// SessionID 返回 sessionid (即 mpay 的 user.token)
func (c *SauthCookie) SessionID() string {
	v, _ := c.Get("sessionid")
	return v
}

// SDKUid 返回 sdkuid (即 mpay 的 user.id)
func (c *SauthCookie) SDKUid() string {
	v, _ := c.Get("sdkuid")
	return v
}
