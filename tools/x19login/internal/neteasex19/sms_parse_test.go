package neteasex19

import (
	"errors"
	"testing"
)

func TestSmsChallengeParsing(t *testing.T) {
	// 成功：HTTP 200 + guide_text
	ch, err := parseSmsChallenge(200, []byte(`{"guide_text":"验证码已发送"}`))
	if err != nil || ch.Hint != "验证码已发送" {
		t.Fatalf("成功响应解析错误: ch=%+v err=%v", ch, err)
	}

	// 200 + code：必须当错误（之前会误报已发送）
	_, err = parseSmsChallenge(200, []byte(`{"code":1351,"reason":"需要人机验证","verify_url":"https://example/verify"}`))
	var me *MPayError
	if !errors.As(err, &me) || me.Code != 1351 || me.VerifyURL == "" {
		t.Fatalf("200+code 未当错误处理: %v", err)
	}

	// 200 + 上行短信
	_, err = parseSmsChallenge(200, []byte(`{"code":1373,"reason":"先发短信","reply_sms":{"content":"1","number":"1069"}}`))
	if !errors.As(err, &me) || !me.IsUpstreamSMS() || me.ReplySMS == nil {
		t.Fatalf("上行短信未识别: %v", err)
	}
}
