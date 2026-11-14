// Package neteasex19 提供网易账号登录《我的世界》中国版 (x19) 的完整实现。
//
// 支持的登录方式:
//
//   - 网易邮箱 + 密码     LoginByEmail
//   - 手机号 + 密码       LoginByPhonePassword
//   - 手机号 + 短信验证码 LoginByPhoneSms
//   - 已有 sauth 登录态   LoginBySauth
//   - 自动识别账号类型     Login
//
// 所有方式最终都会返回 *Session, 其中保存了 x19 的 entity_id 与 token。
//
// 典型用法:
//
//	session, err := neteasex19.LoginByPhoneSms(ctx, "13800000000",
//	    neteasex19.WithSmsCodeHandler(func(c *neteasex19.SmsChallenge) (string, error) {
//	        fmt.Printf("短信验证码: ")
//	        var code string
//	        fmt.Scanln(&code)
//	        return code, nil
//	    }))
//	if err != nil {
//	    log.Fatal(err)
//	}
//	defer session.StopHeartbeat()
//	session.StartHeartbeat(4 * time.Minute)
//
// 登录链路: 网易 mpay 账号中台 -> sauth 登录态 -> x19 uni_sauth -> login-otp
// -> authentication-otp -> Session(entity_id + token)。
//
// 需要恢复上次登录时, 可用 NewSession 直接携带 entity_id 与 token 启动心跳,
// 无需重新走账号密码流程。
package neteasex19
