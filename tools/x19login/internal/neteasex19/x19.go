package neteasex19

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
)

const (
	coreBase  = "https://x19obtcore.nie.netease.com:8443"
	gateway   = "https://x19apigatewayobt.nie.netease.com"
	uniSauth  = "https://mgbsdk.matrix.netease.com/x19/sdk/uni_sauth"
	userAgent = "WPFLauncher/0.0.0.0"
)

// flexInt 兼容 JSON 中的 "123" 与 123 两种写法
type flexInt int

func (f *flexInt) UnmarshalJSON(b []byte) error {
	s := strings.Trim(string(b), `"`)
	if s == "" || s == "null" {
		*f = 0
		return nil
	}
	v, err := strconv.ParseInt(s, 10, 64)
	if err != nil {
		return fmt.Errorf("解析整数失败: %s", string(b))
	}
	*f = flexInt(v)
	return nil
}

func (f flexInt) MarshalJSON() ([]byte, error) {
	return []byte(strconv.Itoa(int(f))), nil
}

// flexUint64 兼容 JSON 中的 "123" 与 123 两种写法
type flexUint64 uint64

func (f *flexUint64) UnmarshalJSON(b []byte) error {
	s := strings.Trim(string(b), `"`)
	if s == "" || s == "null" {
		*f = 0
		return nil
	}
	v, err := strconv.ParseUint(s, 10, 64)
	if err != nil {
		return fmt.Errorf("解析无符号整数失败: %s", string(b))
	}
	*f = flexUint64(v)
	return nil
}

func (f flexUint64) MarshalJSON() ([]byte, error) {
	return []byte(strconv.FormatUint(uint64(f), 10)), nil
}

// ResponseX19Base 对应 Kotlin 端 ResponseX19Base
type ResponseX19Base struct {
	Code    flexInt         `json:"code"`
	Message string          `json:"message"`
	Details string          `json:"details"`
	Entity  json.RawMessage `json:"entity"`
}

func (r *ResponseX19Base) throwOnNotOk() error {
	if int(r.Code) != 0 {
		if r.Message != "" {
			return errors.New(r.Message)
		}
		return fmt.Errorf("x19 返回错误码 %d", int(r.Code))
	}
	return nil
}

// X19LoginOtp 对应 Kotlin 端 X19LoginOtp
type X19LoginOtp struct {
	Otp      flexInt    `json:"otp"`
	OtpToken string     `json:"otp_token"`
	Aid      flexUint64 `json:"aid"`
}

// AuthEntity 对应 Kotlin 端 X19AuthenticationEntity
type AuthEntity struct {
	EntityID     flexUint64 `json:"entity_id"`
	Aid          flexUint64 `json:"aid"`
	Token        string     `json:"token"`
	Sead         string     `json:"sead"`
	VerifyStatus flexInt    `json:"verify_status"`
	HasGmail     bool       `json:"hasGmail"`
	IsNew        bool       `json:"is_register"`
}

// X19Client x19 (我的世界中国版启动器) 客户端
type X19Client struct {
	Client *http.Client
}

// NewX19Client 创建 x19 客户端
func NewX19Client(client *http.Client) *X19Client {
	if client == nil {
		client = &http.Client{Timeout: 30 * time.Second}
	}
	return &X19Client{Client: client}
}

func (c *X19Client) newRequest(ctx context.Context, method, rawURL string, body []byte, contentType string) (*http.Request, error) {
	var reader io.Reader
	if body != nil {
		reader = bytes.NewReader(body)
	}
	req, err := http.NewRequestWithContext(ctx, method, rawURL, reader)
	if err != nil {
		return nil, err
	}
	req.Header.Set("User-Agent", userAgent)
	if contentType != "" {
		req.Header.Set("Content-Type", contentType)
	}
	return req, nil
}

func (c *X19Client) do(ctx context.Context, method, rawURL string, body []byte, contentType string) ([]byte, error) {
	req, err := c.newRequest(ctx, method, rawURL, body, contentType)
	if err != nil {
		return nil, err
	}
	resp, err := c.Client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		b, _ := io.ReadAll(resp.Body)
		return nil, fmt.Errorf("%s %s 状态异常: %d body=%s", method, rawURL, resp.StatusCode, truncate(string(b), 256))
	}
	return io.ReadAll(resp.Body)
}

func decodeResponseX19(b []byte) (*ResponseX19Base, error) {
	var resp ResponseX19Base
	if err := json.Unmarshal(b, &resp); err != nil {
		return nil, fmt.Errorf("解析 x19 响应失败: %w (body=%s)", err, truncate(string(b), 256))
	}
	return &resp, nil
}

// UniCookie 复刻 WPLauncherAPI.uniCookie
// 向网易侧上报 SDK 登录态 (sauth), 是 x19 认证的前置步骤
func (c *X19Client) UniCookie(ctx context.Context, cookie *SauthCookie) error {
	if cookie == nil {
		return errors.New("uni_sauth: sauth 为空")
	}
	// 官方实现在这一步会写入/覆盖 client_login_sn
	body := cookie.Clone()
	body.Set("client_login_sn", randomString(16, hexCharset))

	b, err := c.do(ctx, http.MethodPost, uniSauth, []byte(body.JSON()), "application/json")
	if err != nil {
		return err
	}
	var resp struct {
		Code    int    `json:"code"`
		Message string `json:"msg"`
		SubCode int    `json:"subcode"`
		Aid     uint64 `json:"aid"`
		SDKUid  string `json:"sdkuid"`
		Debug   string `json:"debug_message"`
	}
	if err := json.Unmarshal(b, &resp); err != nil {
		return fmt.Errorf("解析 uni_sauth 响应失败: %w (body=%s)", err, truncate(string(b), 256))
	}
	if resp.Code != 200 {
		msg := resp.Message
		if detail := decodeX19DebugMessage(resp.Debug); detail != "" {
			if msg == "" {
				msg = detail
			} else {
				msg = msg + ": " + detail
			}
		}
		if msg == "" {
			msg = truncate(string(b), 256)
		}
		return fmt.Errorf("uni_sauth 失败: %s", msg)
	}
	return nil
}

// decodeX19DebugMessage 解码网易侧 debug_message 字段
// 该字段是 base64 后的 JSON, 形如 {"reason": "用户重复登录。", "code": 1306}
func decodeX19DebugMessage(raw string) string {
	if raw == "" {
		return ""
	}
	decoded, err := base64.StdEncoding.DecodeString(raw)
	if err != nil {
		return ""
	}
	var parsed struct {
		Reason string  `json:"reason"`
		Code   flexInt `json:"code"`
	}
	if err := json.Unmarshal(decoded, &parsed); err != nil || parsed.Reason == "" {
		return ""
	}
	if parsed.Code != 0 {
		return fmt.Sprintf("%s (code=%d)", parsed.Reason, int(parsed.Code))
	}
	return parsed.Reason
}

// LoginCookie 复刻 WPLauncherAPI.loginCookie
// POST /login-otp 获取一次性 OTP
func (c *X19Client) LoginCookie(ctx context.Context, cookie *SauthCookie) (*X19LoginOtp, error) {
	if cookie == nil {
		return nil, errors.New("login-otp: sauth 为空")
	}
	b, err := c.do(ctx, http.MethodPost, coreBase+"/login-otp", cookie.WrappedJSON(), "application/json")
	if err != nil {
		return nil, err
	}
	resp, err := decodeResponseX19(b)
	if err != nil {
		return nil, err
	}
	if err := resp.throwOnNotOk(); err != nil {
		return nil, err
	}
	var otp X19LoginOtp
	if err := json.Unmarshal(resp.Entity, &otp); err != nil {
		return nil, fmt.Errorf("解析 login-otp entity 失败: %w", err)
	}
	return &otp, nil
}

// environment 对应 Kotlin 端 RequestX19Authentication.Environment
type environment struct {
	OSName       string `json:"os_name"`
	OSVersion    string `json:"os_ver"`
	MacAddr      string `json:"mac_addr"`
	UDID         string `json:"udid"`
	AppVersion   string `json:"app_ver"`
	SDKVersion   string `json:"sdk_ver"`
	Network      string `json:"network"`
	Disk         string `json:"disk"`
	Is64bit      int    `json:"is64bit"`
	VideoCard1   string `json:"video_card1"`
	VideoCard2   string `json:"video_card2"`
	VideoCard3   string `json:"video_card3"`
	VideoCard4   string `json:"video_card4"`
	LauncherType string `json:"launcher_type"`
	PayChannel   string `json:"pay_channel"`
}

// authRequest 对应 Kotlin 端 RequestX19Authentication
type authRequest struct {
	OtpToken string      `json:"otp_token"`
	OtpPwd   string      `json:"otp_pwd"`
	Aid      uint64      `json:"aid"`
	Sauth    string      `json:"sauth_json"`
	SaData   string      `json:"sa_data"`
	Version  authVersion `json:"version"`
}

type authVersion struct {
	Version     string `json:"version"`
	LauncherMD5 string `json:"launcher_md5"`
	UpdaterMD5  string `json:"updater_md5"`
}

// Authentication 复刻 WPLauncherAPI.authentication
// POST /authentication-otp 使用 OTP 换取正式 session (entity_id + token)
func (c *X19Client) Authentication(ctx context.Context, cookie *SauthCookie, otp *X19LoginOtp, latestVersion string) (*AuthEntity, error) {
	if cookie == nil {
		return nil, errors.New("authentication-otp: sauth 为空")
	}
	if otp == nil {
		return nil, errors.New("authentication-otp: otp 为空")
	}

	env := environment{
		OSName:       "windows",
		OSVersion:    "Microsoft Windows 10",
		MacAddr:      "00-00-00-00-00-00",
		UDID:         cookie.UDID(),
		AppVersion:   latestVersion,
		SDKVersion:   "",
		Network:      "",
		Disk:         diskFromAid(uint64(otp.Aid)),
		Is64bit:      1,
		VideoCard1:   "NVIDIA GeForce GTX 4060",
		VideoCard2:   "",
		VideoCard3:   "",
		VideoCard4:   "",
		LauncherType: "PC_java",
		PayChannel:   "netease",
	}
	envJSON, err := json.Marshal(&env)
	if err != nil {
		return nil, err
	}

	reqBody := authRequest{
		OtpToken: otp.OtpToken,
		OtpPwd:   "",
		Aid:      uint64(otp.Aid),
		Sauth:    cookie.SauthJSON(),
		SaData:   string(envJSON),
		Version:  authVersion{Version: latestVersion},
	}
	reqJSON, err := json.Marshal(&reqBody)
	if err != nil {
		return nil, err
	}

	encrypted := httpEncrypt(string(reqJSON))
	b, err := c.do(ctx, http.MethodPost, coreBase+"/authentication-otp", encrypted, "application/json")
	if err != nil {
		return nil, err
	}
	plain, err := httpDecrypt(b)
	if err != nil {
		return nil, err
	}
	resp, err := decodeResponseX19([]byte(plain))
	if err != nil {
		return nil, err
	}
	if err := resp.throwOnNotOk(); err != nil {
		return nil, err
	}
	var entity AuthEntity
	if err := json.Unmarshal(resp.Entity, &entity); err != nil {
		return nil, fmt.Errorf("解析 authentication entity 失败: %w", err)
	}
	if entity.EntityID == 0 {
		return nil, errors.New("authentication 返回的 entity_id 为空")
	}
	return &entity, nil
}

// Refresh 复刻 WPLauncherAccountAPI.refresh
// 心跳: POST /authentication/update, 解析响应中的新 token
func (c *X19Client) Refresh(ctx context.Context, id uint64, token string) (string, error) {
	body := fmt.Sprintf(`{"entity_id":%d}`, id)
	plain, err := c.postWithAuth(ctx, coreBase+"/authentication/update", body, token, id, true)
	if err != nil {
		return "", err
	}
	resp, err := decodeResponseX19([]byte(plain))
	if err != nil {
		return "", err
	}
	if err := resp.throwOnNotOk(); err != nil {
		return "", err
	}
	var entity AuthEntity
	if err := json.Unmarshal(resp.Entity, &entity); err != nil {
		return "", fmt.Errorf("解析 authentication/update entity 失败: %w", err)
	}
	if uint64(entity.EntityID) != id {
		return "", fmt.Errorf("心跳返回的 entity_id 不匹配: %d != %d", uint64(entity.EntityID), id)
	}
	return entity.Token, nil
}

// postWithAuth 复刻 WPLauncherAccountAPI.postWithAuth
// 携带 user-id / user-token 头; hasEncrypt=true 时请求体与响应体都经过 httpEncrypt/httpDecrypt
// 返回解密后的响应明文 (若 hasEncrypt=false 则直接返回响应体)
func (c *X19Client) postWithAuth(ctx context.Context, rawURL, body, token string, id uint64, hasEncrypt bool) (string, error) {
	path := rawURL
	if u, err := url.Parse(rawURL); err == nil {
		path = u.Path
	}

	dynamicToken := computeDynamicToken(token, path, body)

	var reqBody []byte
	if hasEncrypt {
		reqBody = httpEncrypt(body)
	} else {
		reqBody = []byte(body)
	}

	req, err := c.newRequest(ctx, http.MethodPost, rawURL, reqBody, "")
	if err != nil {
		return "", err
	}
	req.Header.Set("user-id", strconv.FormatUint(id, 10))
	req.Header.Set("user-token", dynamicToken)

	resp, err := c.Client.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		b, _ := io.ReadAll(resp.Body)
		return "", fmt.Errorf("POST %s 状态异常: %d body=%s", rawURL, resp.StatusCode, truncate(string(b), 256))
	}
	b, err := io.ReadAll(resp.Body)
	if err != nil {
		return "", err
	}
	if hasEncrypt {
		return httpDecrypt(b)
	}
	return string(b), nil
}

// SelfDetail 对应 Kotlin 端 X19SelfDetail, 即当前账号的自身信息
type SelfDetail struct {
	Name      string `json:"name"`             // 昵称
	AvatarURL string `json:"avatar_image_url"` // 头像直链
	Level     uint64 `json:"level"`            // 等级
	IsVIP     bool   `json:"is_vip"`           // 是否 VIP
	Score     int64  `json:"score"`            // 积分
}

// GetSelfDetail 复刻 WPLauncherAccountAPI.getSelfDetail
// 用于验证 token 是否有效
func (c *X19Client) GetSelfDetail(ctx context.Context, id uint64, token string) (*SelfDetail, error) {
	plain, err := c.postWithAuth(ctx, gateway+"/user-detail", "", token, id, false)
	if err != nil {
		return nil, err
	}
	resp, err := decodeResponseX19([]byte(plain))
	if err != nil {
		return nil, err
	}
	if err := resp.throwOnNotOk(); err != nil {
		return nil, err
	}
	var detail SelfDetail
	if err := json.Unmarshal(resp.Entity, &detail); err != nil {
		return nil, fmt.Errorf("解析 user-detail entity 失败: %w", err)
	}
	return &detail, nil
}

// DoLoginStart 复刻 WPLauncherAccountAPI.doLoginStart
// 内部登录状态标记, 创建购买订单前必须调用一次
func (c *X19Client) DoLoginStart(ctx context.Context, id uint64, token string) error {
	plain, err := c.postWithAuth(ctx, gateway+"/interconn/web/game-play-v2/login-start", `{"strict_mode":true}`, token, id, false)
	if err != nil {
		return err
	}
	resp, err := decodeResponseX19([]byte(plain))
	if err != nil {
		return err
	}
	return resp.throwOnNotOk()
}

// Logout 复刻 WPLauncherAccountAPI.logout
func (c *X19Client) Logout(ctx context.Context, id uint64, token string) error {
	body := fmt.Sprintf(`{"user_id":%q,"logout_type":0}`, strconv.FormatUint(id, 10))
	plain, err := c.postWithAuth(ctx, coreBase+"/authentication/delete", body, token, id, false)
	if err != nil {
		return err
	}
	resp, err := decodeResponseX19([]byte(plain))
	if err != nil {
		return err
	}
	return resp.throwOnNotOk()
}
