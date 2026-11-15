package neteasex19

import (
	"bytes"
	"context"
	"crypto/aes"
	"crypto/cipher"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

// PE 通道（基岩版 / 手机版）登录。
//
// x19 的 token 只对 PC 网关有效：g79 的 `/pe-purchase-item/`、`/pe-user-item-purchase`
// 这类 PE 接口会用 token 反查账号，PC 账号对不上就回「参数错误」。
// 所以进联机大厅前顺手做一次 PE 认证，把 PE 通道的 entity_id + token 一起带回来。
//
// 协议来源：VQ 1.6.2 的 MKeyService.PeLoginWithSauthAsync + PeSign + X19Crypt(HttpEncryptG79V12)。
const (
	peServerListURL = "https://g79.update.netease.com/serverlist/ios_release_webv2.json"
	peCoreFallback  = "https://g79obtcore.minecraft.cn:8443"

	peEngineVersion = "3.8.15.292807"
	pePatchVersion  = "3.8.16.292826"
	peEngineHash1   = "f879442b620c8e8540b7cadb0b425a7e"
	peEngineHash2   = "cdd2eea871f2dd8dcef5ee9f87a35f3b2b3e7ca013bb30a74d822579860c042b"
	peSignOffset    = 4
	peSignRounds    = 7

	// peAppVer / peSDKVer 是 PE 客户端上报的版本号，和 engine/patch 不是一套
	peAppVer = "3.9.7.297341"
	peSDKVer = "5.9.0"
)

// keysG79V12 来自 X19Crypt.KeysG79V12（hex 编码的 AES-128 密钥）
var keysG79V12 = [16]string{
	"60F1E0D1FD635362430747215CF1C2FF", "EA5B62D27D0338374852C4B9469D7AC6",
	"17238D55501C5F020B155FB3303591E6", "8C5CEAE0F443E006A050266F73ADD5B0",
	"1C02CE22FB22F0E72060217418F351F3", "9A01773FEBB0CFE0EBDBF37F4D23C27F",
	"43F32300BF252CC320E2572ACE766367", "07F161011B3101F1ED0301735631E734",
	"0454E7707A5F37565601E100406060AF", "647554BAD3100C43C16660F002CC10F3",
	"E157213170F842382032564265B0B043", "914FC59311B04151393EF6896A847636",
	"0710C0205D224237025323265C145FA1", "054E6F01165267025C3111F562A921E9",
	"722D1789E792E2CA0D5322211FD0F5AE", "91F7C751FCF671F34943430772341799",
}

const peRandCharset = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"

// pickKeyG79V12 按尾部标记字节的高 4 位选 key
func pickKeyG79V12(query byte) ([]byte, error) {
	raw, err := hex.DecodeString(keysG79V12[int(query>>4)&0xF])
	if err != nil {
		return nil, err
	}
	if len(raw) != 16 {
		return nil, errors.New("G79 密钥长度非法")
	}
	return raw, nil
}

// httpEncryptG79V12 复刻 X19Crypt.HttpEncryptG79V12
// 输出: iv(16) + AES-128-CBC NoPadding 密文 + 1 字节 (keyIndex<<4 | 0xC)
func httpEncryptG79V12(body []byte) ([]byte, error) {
	keyIndex := randomInt(16)

	input := append(append([]byte{}, body...), []byte(randomString(16, peRandCharset))...)
	iv := randomBytes(aes.BlockSize)

	// 补零到 16 字节整数倍（NoPadding，等价于 C# 里的 Math.Ceiling 分配）
	if r := len(input) % aes.BlockSize; r != 0 {
		input = append(input, make([]byte, aes.BlockSize-r)...)
	}

	key, err := pickKeyG79V12(byte(keyIndex << 4))
	if err != nil {
		return nil, err
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, err
	}
	ciphertext := make([]byte, len(input))
	cipher.NewCBCEncrypter(block, iv).CryptBlocks(ciphertext, input)

	out := make([]byte, 0, len(iv)+len(ciphertext)+1)
	out = append(out, iv...)
	out = append(out, ciphertext...)
	out = append(out, byte(keyIndex<<4|0x0C))
	return out, nil
}

// httpDecryptG79V12 复刻 X19Crypt.HttpDecryptG79V12（PE 普通响应）
func httpDecryptG79V12(body []byte) (string, error) {
	plain, err := decryptG79(body)
	if err != nil {
		return "", err
	}
	last := len(plain) - 1
	for last >= 0 && plain[last] == 0 {
		last--
	}
	if last < 0 {
		return "", errors.New("PE 响应解密为空")
	}
	return string(plain[:last+1]), nil
}

// httpDecryptG79V12Large 复刻 X19Crypt.HttpDecryptG79V12Large：
// 明文尾部还有 128 字节签名区，要整体丢掉。
func httpDecryptG79V12Large(body []byte) (string, error) {
	plain, err := decryptG79(body)
	if err != nil {
		return "", err
	}
	last := len(plain) - 1
	for last >= 0 && plain[last] == 0 {
		last--
	}
	if last < 128 {
		return "", errors.New("PE 响应长度异常")
	}
	return string(plain[:last-127]), nil
}

func decryptG79(body []byte) ([]byte, error) {
	if len(body) < 18 {
		return nil, errors.New("PE 响应太短")
	}
	key, err := pickKeyG79V12(body[len(body)-1])
	if err != nil {
		return nil, err
	}
	iv := body[:16]
	data := body[16 : len(body)-1]
	if len(data)%aes.BlockSize != 0 {
		return nil, errors.New("PE 响应长度不是 16 的整数倍")
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, err
	}
	out := make([]byte, len(data))
	cipher.NewCBCDecrypter(block, iv).CryptBlocks(out, data)
	return out, nil
}

// peSignShift / peSignConst 来自 VQ.Services.PeSign
var peSignShift = [5]uint32{218760705, 235472130, 51054340, 84609027, 235603713}

var peSignConst = [40]uint32{
	4129170786, 3225465664, 643717713, 3921069994, 2763975236, 1272893353, 4139469664, 3200236656, 1700485571, 2399980690,
	4293915773, 2240044497, 681279174, 3936430074, 3572445317, 76029189, 568446438, 3275163606, 4107603335, 1163531501,
	4129170786, 3225465664, 643717713, 3921069994, 2763975236, 1272893353, 4139469664, 3200236656, 1700485571, 2399980690,
	4293915773, 2240044497, 681279174, 3936430074, 3572445317, 76029189, 568446438, 3275163606, 4107603335, 1163531501,
}

// peSign 复刻 PeSign.Compute：不是 MD5，是自制的 4 轮状态机，
// 位移量由 offset 选表，轮数固定 7。message 先右补 '0' 到 4 的倍数。
func peSign(message string, offset, rounds int) ([]byte, error) {
	if message == "" {
		return nil, errors.New("签名内容为空")
	}
	if offset < 0 || offset >= len(peSignShift) {
		return nil, fmt.Errorf("签名 offset 越界: %d", offset)
	}
	for len(message)%4 != 0 {
		message += "0"
	}

	raw := []byte(message)
	words := make([]uint32, 0, len(raw)/4)
	for i := 0; i < len(raw); i += 4 {
		words = append(words, uint32(raw[i])<<24|uint32(raw[i+1])<<16|uint32(raw[i+2])<<8|uint32(raw[i+3]))
	}
	for len(words)%64 != 0 {
		words = append(words, 2882398599)
	}

	shift := peSignShift[offset]
	s0 := shift & 0xFF
	s1 := (shift >> 8) & 0xFF
	s2 := (shift >> 16) & 0xFF
	s3 := (shift >> 24) & 0xFF
	base := offset * 4
	c0, c1, c2, c3 := peSignConst[base], peSignConst[base+1], peSignConst[base+2], peSignConst[base+3]

	var a, b, c, d uint32 = 1732584193, 4023233417, 2562383102, 271733878
	for r := 0; r < rounds; r++ {
		for k := 0; k < len(words); k += 4 {
			w := words[k]
			t1 := w + c0 + ((b & c) | (d &^ b)) + a
			a = b + (t1 << s0)
			t2 := a + w + c1 + ((c &^ d) | (d & b))
			b += t2 << s1
			t3 := a + w + c2 + (b ^ d ^ c)
			c = b + (t3 << s2)
			t4 := a + w + c3 + (c ^ (b | d))
			d = b + (t4 << s3)
		}
	}

	out := make([]byte, 16)
	putLE(out[0:], a)
	putLE(out[4:], b)
	putLE(out[8:], c)
	putLE(out[12:], d)
	return out, nil
}

func putLE(dst []byte, v uint32) {
	dst[0] = byte(v)
	dst[1] = byte(v >> 8)
	dst[2] = byte(v >> 16)
	dst[3] = byte(v >> 24)
}

// PeSession 是 PE 通道的登录结果
type PeSession struct {
	EntityID uint64
	Token    string
	Name     string
	CoreURL  string
}

// peCoreServerURL 取 PE 核心服地址（失败时用内置兜底）
func peCoreServerURL(ctx context.Context, client *http.Client) string {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, peServerListURL, nil)
	if err != nil {
		return peCoreFallback
	}
	resp, err := client.Do(req)
	if err != nil {
		return peCoreFallback
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil {
		return peCoreFallback
	}
	var cfg struct {
		CoreServerURL string `json:"CoreServerUrl"`
	}
	if err := json.Unmarshal(body, &cfg); err != nil || strings.TrimSpace(cfg.CoreServerURL) == "" {
		return peCoreFallback
	}
	return strings.TrimSpace(cfg.CoreServerURL)
}

// peUDIDFile 让 PE 设备 id 跨进程复用：同一个 id 反复注册容易被风控
func peUDIDFile(cachePath string) string {
	if strings.TrimSpace(cachePath) == "" {
		return ""
	}
	return filepath.Join(filepath.Dir(cachePath), "pe-udid.txt")
}

// PeUDID 读取（或生成并保存）PE 设备 id
func PeUDID(cachePath string) string {
	if file := peUDIDFile(cachePath); file != "" {
		if raw, err := os.ReadFile(file); err == nil {
			if v := strings.TrimSpace(string(raw)); len(v) >= 16 {
				return v
			}
		}
	}
	udid := randomString(32, "0123456789ABCDEF")
	if file := peUDIDFile(cachePath); file != "" {
		if err := os.MkdirAll(filepath.Dir(file), 0o700); err == nil {
			_ = os.WriteFile(file, []byte(udid+"\n"), 0o600)
		}
	}
	return udid
}

// buildPeSaData 复刻 MKeyService.BuildPeSaData
func buildPeSaData(udid string) map[string]any {
	return map[string]any{
		"app_channel":   "netease",
		"app_ver":       peAppVer,
		"core_num":      "24",
		"cpu_digit":     "0",
		"cpu_hz":        "",
		"cpu_name":      "Intel(R) Core(TM) i7-14650HX",
		"device_height": "2538",
		"device_model":  "Win32",
		"device_width":  "1472",
		"disk":          "",
		"emulator":      0,
		"first_udid":    udid,
		"is_guest":      0,
		"launcher_type": "PE_C++",
		"mac_addr":      "02:00:00:00:00:00",
		"network":       "CHANNEL_UNKNOW",
		"os_name":       "windows",
		"os_ver":        "10.0.26100",
		"ram":           "16790933504",
		"rom":           "",
		"root":          false,
		"sdk_ver":       peSDKVer,
		"start_type":    "default",
		"udid":          udid,
	}
}

// peSauthInner 取出要提交给 PE 的 sauth：优先 sauth_json 内层，并强制 platform=ad
func peSauthInner(cookie *SauthCookie) (map[string]any, error) {
	if cookie == nil {
		return nil, errors.New("缺少 sauth，无法做 PE 认证")
	}
	raw := cookie.JSON()
	if inner, ok := cookie.Get("sauth_json"); ok && strings.TrimSpace(inner) != "" {
		raw = inner
	}
	var m map[string]any
	if err := json.Unmarshal([]byte(raw), &m); err != nil {
		return nil, fmt.Errorf("解析 sauth 失败: %w", err)
	}
	m["platform"] = "ad"
	return m, nil
}

// PeLogin 用 sauth 换 PE 通道 token（MKeyService.PeLoginWithSauthAsync）
func PeLogin(ctx context.Context, cookie *SauthCookie, client *http.Client, cachePath string) (*PeSession, error) {
	if client == nil {
		client = http.DefaultClient
	}
	core := peCoreServerURL(ctx, client)

	seed := randomUUID()
	message := peEngineVersion + peEngineHash1 + pePatchVersion + peEngineHash2 + seed
	sign, err := peSign(message, peSignOffset, peSignRounds)
	if err != nil {
		return nil, err
	}
	inner, err := peSauthInner(cookie)
	if err != nil {
		return nil, err
	}

	payload := map[string]any{
		"sa_data":        buildPeSaData(PeUDID(cachePath)),
		"engine_version": peEngineVersion,
		"patch_version":  pePatchVersion,
		"message":        message,
		"sauth_json":     inner,
		"seed":           seed,
		"sign":           base64.StdEncoding.EncodeToString(sign),
	}
	body, err := json.Marshal(payload)
	if err != nil {
		return nil, err
	}
	enc, err := httpEncryptG79V12(body)
	if err != nil {
		return nil, err
	}

	url := strings.TrimRight(core, "/") + "/pe-authentication"
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, strings.NewReader(hex.EncodeToString(enc)))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("User-Agent", "okhttp/3.12.13")

	resp, err := client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("PE 认证请求失败: %w", err)
	}
	defer resp.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(resp.Body, 4<<20))
	if err != nil {
		return nil, fmt.Errorf("PE 认证响应读取失败: %w", err)
	}
	text := strings.TrimSpace(string(raw))
	// 服务端偶尔直接回明文 JSON（例如网关限流），先兼容
	if !strings.HasPrefix(text, "{") {
		bin, derr := hex.DecodeString(text)
		if derr != nil {
			return nil, fmt.Errorf("PE 认证响应不是 hex（HTTP %d）: %s", resp.StatusCode, truncate(text, 160))
		}
		text, derr = httpDecryptG79V12Large(bin)
		if derr != nil {
			return nil, fmt.Errorf("PE 响应解密失败: %w", derr)
		}
	}

	var out struct {
		Code    json.Number `json:"code"`
		Message string      `json:"message"`
		Entity  struct {
			EntityID json.Number `json:"entity_id"`
			Token    string      `json:"token"`
		} `json:"entity"`
	}
	if err := json.Unmarshal(bytes.TrimSpace([]byte(text)), &out); err != nil {
		return nil, fmt.Errorf("PE 响应解析失败: %w（%s）", err, truncate(text, 160))
	}
	if code := strings.TrimSpace(out.Code.String()); code != "" && code != "0" {
		msg := out.Message
		if msg == "" {
			msg = "PE 认证失败(code=" + code + ")"
		}
		return nil, errors.New(msg)
	}
	entityID, convErr := strconv.ParseUint(strings.TrimSpace(out.Entity.EntityID.String()), 10, 64)
	if convErr != nil || entityID == 0 || out.Entity.Token == "" {
		return nil, errors.New("PE 响应缺少 entity_id 或 token")
	}
	return &PeSession{
		EntityID: entityID,
		Token:    out.Entity.Token,
		CoreURL:  core,
	}, nil
}

// randomUUID 生成标准 8-4-4-4-12 UUID（PE seed 用，服务端只当随机串）
func randomUUID() string {
	b := randomBytes(16)
	b[6] = (b[6] & 0x0F) | 0x40
	b[8] = (b[8] & 0x3F) | 0x80
	h := hex.EncodeToString(b)
	return h[0:8] + "-" + h[8:12] + "-" + h[12:16] + "-" + h[16:20] + "-" + h[20:32]
}
