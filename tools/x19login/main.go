// Command x19login 是 Cubeloom 的网易账号登录助手。
//
// 它只做一件事：用账号密码 / 短信 / 已有 sauth 换到 x19 的 entity_id + token，
// 然后以 NDJSON 的形式告诉 Cubeloom。房间解析、启动面板、引擎参数都在 Node 侧完成。
//
// 协议（stdin / stdout 各一行一个 JSON）：
//
//	stdin  第一行：{"mode":"email|phone|sms|sauth","account":"…","password":"…","sauth":"…",
//	                "cache":"…","project":"x19","gv":"c1.25.0"}
//	stdout 事件：  {"event":"notice","message":"…"}
//	              {"event":"sms_required","upstream":false,"phone":"…"}
//	              {"event":"sms_upstream","phone":"…","number":"…","content":"…"}
//	              {"event":"result","entity_id":123,"token":"…","name":"…"}
//	              {"event":"error","message":"…"}
//
//	stdin 后续行：{"code":"123456"}  回答 sms_required
//	              {"ack":"ok"}       回答 sms_upstream（用户已发完上行短信）
//	              {"password":"…"}   第一行没带密码时补发
//
// 口令只存在于本进程内存，不写盘、不回显、不进日志。
package main

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"sync"
	"time"

	"cubeloom/x19login/internal/neteasex19"
)

type loginRequest struct {
	Mode     string `json:"mode"`
	Account  string `json:"account"`
	Password string `json:"password"`
	Sauth    string `json:"sauth"`
	Cache    string `json:"cache"`
	Project  string `json:"project"`
	GV       string `json:"gv"`
	// 恢复登录态（导出/保存的 token）用；兼容字符串/数字两种写法
	EntityID flexUint64 `json:"entity_id"`
	Token    string     `json:"token"`
}

// flexUint64 接受 JSON 数字或字符串（Node 侧 entity_id 是字符串）。
type flexUint64 uint64

func (f *flexUint64) UnmarshalJSON(b []byte) error {
	s := strings.Trim(string(b), `"`)
	if s == "" || s == "null" {
		*f = 0
		return nil
	}
	n, err := strconv.ParseUint(s, 10, 64)
	if err != nil {
		return fmt.Errorf("entity_id 需要是数字：%w", err)
	}
	*f = flexUint64(n)
	return nil
}

type reply struct {
	Code     string `json:"code"`
	Password string `json:"password"`
	Ack      string `json:"ack"`
}

var (
	outMu   sync.Mutex
	stdinCh = make(chan []byte, 8)
)

func emit(v any) {
	outMu.Lock()
	defer outMu.Unlock()
	enc := json.NewEncoder(os.Stdout)
	enc.SetEscapeHTML(false)
	_ = enc.Encode(v)
}

func notice(message string) {
	emit(map[string]any{"event": "notice", "message": message})
}

func fail(err error) {
	emit(map[string]any{"event": "error", "message": err.Error()})
}

func main() {
	timeout := flag.Duration("timeout", 5*time.Minute, "整体登录超时")
	flag.Parse()

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt)
	defer stop()
	ctx, cancel := context.WithTimeout(ctx, *timeout)
	defer cancel()

	go func() {
		sc := bufio.NewScanner(os.Stdin)
		sc.Buffer(make([]byte, 0, 64*1024), 1<<20)
		for sc.Scan() {
			line := strings.TrimSpace(sc.Text())
			if line == "" {
				continue
			}
			stdinCh <- []byte(line)
		}
		close(stdinCh)
	}()

	var req loginRequest
	if err := readJSON(ctx, &req); err != nil {
		fail(fmt.Errorf("读取登录参数失败：%w", err))
		os.Exit(2)
	}

	session, err := run(ctx, &req)
	if err != nil {
		fail(err)
		os.Exit(1)
	}

	// 尽量补一次昵称；失败不影响 token 可用性。
	name := session.Name
	if name == "" {
		if d, derr := session.GetSelfDetail(ctx); derr == nil {
			name = d.Name
		} else {
			notice("查询昵称失败（token 仍然可用）：" + derr.Error())
		}
	}

	emit(map[string]any{
		"event":     "result",
		"entity_id": session.ID,
		"token":     session.Token(),
		"name":      name,
	})
}

func readJSON(ctx context.Context, v any) error {
	select {
	case <-ctx.Done():
		return ctx.Err()
	case line, ok := <-stdinCh:
		if !ok {
			return errors.New("stdin 已关闭")
		}
		return json.Unmarshal(line, v)
	}
}

func options(req *loginRequest) []neteasex19.Option {
	opts := []neteasex19.Option{
		neteasex19.WithNoticeHandler(notice),
		neteasex19.WithSmsCodeHandler(func(c *neteasex19.SmsChallenge) (string, error) {
			return askCode(c)
		}),
	}
	if req.Cache != "" {
		opts = append(opts, neteasex19.WithDeviceCacheFile(req.Cache))
	}
	if req.Project != "" {
		opts = append(opts, neteasex19.WithProject(req.Project))
	}
	if req.GV != "" {
		opts = append(opts, neteasex19.WithGameVersion(req.GV))
	}
	return opts
}

func askCode(c *neteasex19.SmsChallenge) (string, error) {
	if c.Upstream {
		emit(map[string]any{
			"event":   "sms_upstream",
			"phone":   c.Phone,
			"number":  c.Number,
			"content": c.Content,
			"hint":    c.Hint,
		})
		var r reply
		if err := readJSON(context.Background(), &r); err != nil {
			return "", err
		}
		if r.Ack == "" {
			return "", errors.New("未确认上行短信")
		}
		// 库会拿这个非空串作为 up_content 轮询
		return "sent", nil
	}

	emit(map[string]any{"event": "sms_required", "upstream": false, "phone": c.Phone, "hint": c.Hint})
	var r reply
	if err := readJSON(context.Background(), &r); err != nil {
		return "", err
	}
	code := strings.TrimSpace(r.Code)
	if code == "" {
		return "", errors.New("没有收到短信验证码")
	}
	return code, nil
}

func askPassword() (string, error) {
	emit(map[string]any{"event": "password_required"})
	var r reply
	if err := readJSON(context.Background(), &r); err != nil {
		return "", err
	}
	if r.Password == "" {
		return "", errors.New("没有收到密码")
	}
	return r.Password, nil
}

// normalizeAccount 把手机号统一成 11 位（去 +86/0086/空格/横线/括号），邮箱只 trim。
// 网易 mpay 只认 11 位大陆号码，不带区号。
func normalizeAccount(raw string) string {
	s := strings.TrimSpace(raw)
	if s == "" || strings.Contains(s, "@") {
		return s
	}
	s = strings.NewReplacer(" ", "", "\t", "", "-", "", "(", "", ")", "", "（", "", "）", "").Replace(s)
	for _, prefix := range []string{"+86", "0086", "86"} {
		if strings.HasPrefix(s, prefix) && isPhone11(s[len(prefix):]) {
			s = s[len(prefix):]
			break
		}
	}
	for strings.HasPrefix(s, "0") && isPhone11(strings.TrimLeft(s, "0")) {
		s = strings.TrimLeft(s, "0")
	}
	return s
}

func isPhone11(s string) bool {
	if len(s) != 11 || s[0] != '1' {
		return false
	}
	for _, r := range s {
		if r < '0' || r > '9' {
			return false
		}
	}
	return true
}

func run(ctx context.Context, req *loginRequest) (*neteasex19.Session, error) {
	req.Account = normalizeAccount(req.Account)
	mode := strings.ToLower(strings.TrimSpace(req.Mode))

	// 刷新/恢复已有登录态：不碰账号密码，只用 entity_id + token
	if mode == "refresh" || (mode == "" && req.EntityID > 0 && strings.TrimSpace(req.Token) != "") {
		if req.EntityID == 0 || strings.TrimSpace(req.Token) == "" {
			return nil, errors.New("恢复登录态需要 entity_id 与 token")
		}
		session := neteasex19.NewSession(uint64(req.EntityID), req.Token, nil)
		if err := session.Refresh(ctx); err != nil {
			return nil, fmt.Errorf("刷新登录态失败：%w", err)
		}
		if _, err := session.GetSelfDetail(ctx); err != nil {
			notice("查询昵称失败（token 已刷新，仍然可用）：" + err.Error())
		}
		return session, nil
	}
	if mode == "" {
		if req.Sauth != "" {
			mode = "sauth"
		} else if strings.Contains(req.Account, "@") {
			mode = "email"
		} else if isPhone11(req.Account) {
			mode = "phone"
		} else {
			mode = "sms"
		}
	}

	switch mode {
	case "email", "phone", "sms", "sauth":
	default:
		return nil, fmt.Errorf("未知的登录方式 %q", req.Mode)
	}

	if mode != "sauth" && strings.TrimSpace(req.Account) == "" {
		return nil, errors.New("缺少账号（网易邮箱或手机号）")
	}
	if (mode == "phone" || mode == "sms") && !isPhone11(req.Account) {
		return nil, fmt.Errorf("手机号登录需要 11 位大陆号码（不带 +86），收到 %q", req.Account)
	}
	if (mode == "email" || mode == "phone") && req.Password == "" {
		pwd, err := askPassword()
		if err != nil {
			return nil, err
		}
		req.Password = pwd
	}

	opts := options(req)
	var (
		session *neteasex19.Session
		err     error
	)
	switch mode {
	case "email":
		session, err = neteasex19.LoginByEmail(ctx, req.Account, req.Password, opts...)
	case "phone":
		session, err = neteasex19.LoginByPhonePassword(ctx, req.Account, req.Password, opts...)
	case "sms":
		session, err = neteasex19.LoginByPhoneSms(ctx, req.Account, opts...)
	case "sauth":
		session, err = neteasex19.LoginBySauth(ctx, req.Sauth, opts...)
	}
	if err != nil {
		return nil, err
	}
	if session == nil || session.Token() == "" {
		return nil, errors.New("登录没有返回 token")
	}
	return session, nil
}
