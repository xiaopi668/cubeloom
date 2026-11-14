package neteasex19

import (
	"bytes"
	"crypto/aes"
	"crypto/cipher"
	"crypto/md5"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"strings"
)

// neteaseSalt 来自 NetEaseEncryptUtils.SALT
const neteaseSalt = "0eGsBkhl"

// neteaseKeys 来自 NetEaseEncryptUtils.keys (16 字节密钥 -> AES-128)
var neteaseKeys = [][]byte{
	[]byte("MK6mipwmOUedplb6"),
	[]byte("OtEylfId6dyhrfdn"),
	[]byte("VNbhn5mvUaQaeOo9"),
	[]byte("bIEoQGQYjKd02U0J"),
	[]byte("fuaJrPwaH2cfXXLP"),
	[]byte("LEkdyiroouKQ4XN1"),
	[]byte("jM1h27H4UROu427W"),
	[]byte("DhReQada7gZybTDk"),
	[]byte("ZGXfpSTYUvcdKqdY"),
	[]byte("AZwKf7MWZrJpGR5W"),
	[]byte("amuvbcHw38TcSyPU"),
	[]byte("SI4QotspbjhyFdT0"),
	[]byte("VP4dhjKnDGlSJtbB"),
	[]byte("UXDZx4KhZywQ2tcn"),
	[]byte("NIK73ZNvNqzva4kd"),
	[]byte("WeiW7qU766Q1YQZI"),
}

func md5hex(s string) string {
	sum := md5.Sum([]byte(s))
	return hex.EncodeToString(sum[:])
}

// computeDynamicToken 复刻 NetEaseEncryptUtils.computeDynamicToken
// 用于生成 user-token 请求头
func computeDynamicToken(token, path, body string) string {
	p := strings.TrimPrefix(path, "/")
	saltHex := md5hex(md5hex(token) + body + neteaseSalt + "/" + p)

	// saltHex 的每个字符转成 8 位二进制串 (MSB first)
	binary := make([]byte, 0, len(saltHex)*8)
	for i := 0; i < len(saltHex); i++ {
		b := saltHex[i]
		for j := 7; j >= 0; j-- {
			if b&(1<<uint(j)) != 0 {
				binary = append(binary, '1')
			} else {
				binary = append(binary, '0')
			}
		}
	}

	// 循环左移 6 位
	binary = append(binary[6:], binary[:6]...)

	out := make([]byte, 12)
	for i := 0; i < 12; i++ {
		var b byte
		for j := 0; j < 8; j++ {
			// Kotlin: num 从 i*8+7 递减到 i*8, j 对应低位
			if binary[i*8+(7-j)] == '1' {
				b |= 1 << uint(j)
			}
		}
		out[i] = saltHex[i] ^ b
	}

	enc := base64.StdEncoding.EncodeToString(out) + "1"
	enc = strings.ReplaceAll(enc, "+", "m")
	enc = strings.ReplaceAll(enc, "/", "o")
	return enc
}

// httpEncrypt 复刻 NetEaseEncryptUtils.httpEncrypt
// 输出: iv(16) + AES-128-CBC NoPadding 密文 + 1 字节 (keyIndex<<4 | 2)
func httpEncrypt(body string) []byte {
	keyIndex := randomInt(len(neteaseKeys))

	input := append([]byte(body), []byte(randomString(16, hexCharset))...)
	iv := randomBytes(aes.BlockSize)

	block, err := aes.NewCipher(neteaseKeys[keyIndex])
	if err != nil {
		panic(err)
	}

	padded := input
	if r := len(padded) % aes.BlockSize; r != 0 {
		padded = append(padded, make([]byte, aes.BlockSize-r)...)
	}

	ciphertext := make([]byte, len(padded))
	cipher.NewCBCEncrypter(block, iv).CryptBlocks(ciphertext, padded)

	out := make([]byte, 0, len(iv)+len(ciphertext)+1)
	out = append(out, iv...)
	out = append(out, ciphertext...)
	out = append(out, byte(keyIndex<<4|2))
	return out
}

// httpDecrypt 复刻 NetEaseEncryptUtils.httpDecrypt
func httpDecrypt(encode []byte) (string, error) {
	if len(encode) < 17 {
		return "", errors.New("invalid encrypted data: too short")
	}
	last := encode[len(encode)-1]
	keyIndex := (last >> 4) & 0xF
	iv := encode[:16]
	data := encode[16 : len(encode)-1]

	block, err := aes.NewCipher(neteaseKeys[keyIndex])
	if err != nil {
		return "", err
	}
	decrypted := make([]byte, len(data))
	cipher.NewCBCDecrypter(block, iv).CryptBlocks(decrypted, data)

	lastNonZero := -1
	for i := len(decrypted) - 1; i >= 0; i-- {
		if decrypted[i] != 0 {
			lastNonZero = i
			break
		}
	}
	if lastNonZero < 15 {
		return "", errors.New("invalid decrypted data")
	}
	return string(decrypted[:lastNonZero-15]), nil
}

// aesECBPKCS7Hex 复刻 MpayLoginEncrypt: AES/ECB/PKCS7Padding 后输出 hex 小写字符串
// key 为 16 字节的 AES-128 密钥 (由设备密钥 hex 解码得到)
func aesECBPKCS7Hex(plain []byte, key []byte) (string, error) {
	block, err := aes.NewCipher(key)
	if err != nil {
		return "", err
	}
	padLen := aes.BlockSize - len(plain)%aes.BlockSize
	padded := append(append([]byte{}, plain...), bytes.Repeat([]byte{byte(padLen)}, padLen)...)

	out := make([]byte, len(padded))
	for i := 0; i < len(padded); i += aes.BlockSize {
		block.Encrypt(out[i:i+aes.BlockSize], padded[i:i+aes.BlockSize])
	}
	return hex.EncodeToString(out), nil
}
