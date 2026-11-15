package neteasex19

import (
	"context"
	"net/http"
	"os"
	"testing"
	"time"
)

// 真实打一次 PE 认证网关，验证 G79 加密 / PeSign / 解密链路是否通。
// 只在 PE_PROBE=1 时跑（不依赖账号：随便一份 sauth，服务端会拒，但链路能验证）。
func TestPeLoginProbe(t *testing.T) {
	if os.Getenv("PE_PROBE") != "1" {
		t.Skip("设置 PE_PROBE=1 才打真实网关")
	}
	cookie, err := ParseSauthCookie(os.Getenv("PE_SAUTH"))
	if err != nil {
		t.Fatalf("解析 sauth 失败: %v", err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	pe, err := PeLogin(ctx, cookie, http.DefaultClient, "")
	if err != nil {
		t.Logf("PE 认证返回错误（链路已打通时这也是预期）：%v", err)
		return
	}
	t.Logf("PE 认证成功：entity_id=%d token=%d 字节", pe.EntityID, len(pe.Token))
}
