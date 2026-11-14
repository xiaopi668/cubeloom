package neteasex19

import (
	crand "crypto/rand"
	"math/big"
)

// hexCharset 与 Kotlin 端 Random.nextString 的默认字符集一致
const hexCharset = "0123456789abcde"

// diskCharset 与 Kotlin 端 Environment.disk 使用的字符集一致 (注意没有 D)
const diskCharset = "0123456789ABCEF"

// randomString 生成 n 个字符, 字符集为 charset
func randomString(n int, charset string) string {
	if n <= 0 || charset == "" {
		return ""
	}
	b := make([]byte, n)
	max := big.NewInt(int64(len(charset)))
	for i := range b {
		idx, err := crand.Int(crand.Reader, max)
		if err != nil {
			panic(err)
		}
		b[i] = charset[idx.Int64()]
	}
	return string(b)
}

func randomBytes(n int) []byte {
	b := make([]byte, n)
	if _, err := crand.Read(b); err != nil {
		panic(err)
	}
	return b
}

// randomInt 返回 [0, n) 内的随机整数 (n <= 0 时返回 0)
func randomInt(n int) int {
	if n <= 0 {
		return 0
	}
	idx, err := crand.Int(crand.Reader, big.NewInt(int64(n)))
	if err != nil {
		panic(err)
	}
	return int(idx.Int64())
}

// randomMAC 复刻 Kotlin 端 RandomUtils.nextMacAddress:
// 6 个随机字节, 首字节置位本地管理地址 (mac[0] = (mac[0] & 0xFE) | 0x02), 大写冒号分隔
func randomMAC() string {
	mac := randomBytes(6)
	mac[0] = (mac[0] & 0xFE) | 0x02
	const hexDigits = "0123456789ABCDEF"
	out := make([]byte, 0, 17)
	for i, b := range mac {
		if i > 0 {
			out = append(out, ':')
		}
		out = append(out, hexDigits[b>>4], hexDigits[b&0x0F])
	}
	return string(out)
}

// xorWow 复刻 kotlin.random.XorWowRandom (Random(seed) 在 JVM 上的实现)
type xorWow struct {
	x, y, z, w uint32
}

func newXorWow(seed int64) *xorWow {
	return &xorWow{
		x: uint32(seed) | 1,
		y: uint32(seed>>32) | 1,
		z: 1,
		w: 0,
	}
}

func (r *xorWow) nextBits(bitCount int) uint32 {
	x, y, z, w := r.x, r.y, r.z, r.w
	t := x ^ (x << 11)
	r.x, r.y, r.z, r.w = y, z, w, (w^(w>>19))^(t^(t>>8))
	return r.w >> (32 - bitCount)
}

// nextInt 复刻 kotlin Random.nextInt(until), until=16 时无拒绝采样
func (r *xorWow) nextInt(until int) int {
	return int(r.nextBits(31) % uint32(until))
}

// diskFromAid 复刻 Kotlin: Random(aid.toLong()).nextString(6, "0123456789ABCEF")
func diskFromAid(aid uint64) string {
	r := newXorWow(int64(aid))
	b := make([]byte, 6)
	for i := range b {
		b[i] = diskCharset[r.nextInt(len(diskCharset))]
	}
	return string(b)
}
