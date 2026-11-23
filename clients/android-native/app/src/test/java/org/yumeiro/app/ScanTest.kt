package org.yumeiro.app

import com.google.zxing.BarcodeFormat
import com.google.zxing.BinaryBitmap
import com.google.zxing.DecodeHintType
import com.google.zxing.EncodeHintType
import com.google.zxing.MultiFormatReader
import com.google.zxing.PlanarYUVLuminanceSource
import com.google.zxing.common.HybridBinarizer
import com.google.zxing.qrcode.QRCodeWriter
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class ScanTest {
    private val host = "yumeiro.example.com"

    @Test fun loginCodeFromOwnServer() {
        assertEquals(ScanTarget.Login("abc-DEF_123"), parseScan("https://yumeiro.example.com/?qr=abc-DEF_123", host))
    }
    @Test fun otherServerIsRejected() {
        val t = parseScan("https://evil.example.net/?qr=abc", host)
        assertTrue(t is ScanTarget.Rejected && t.reason.contains("别的服务器"))
        // 域名里夹带自己的域名也不行
        assertTrue(parseScan("https://yumeiro.example.com.evil.net/?qr=abc", host) is ScanTarget.Rejected)
        assertTrue(parseScan("https://evil.net/?x=yumeiro.example.com&qr=abc", host) is ScanTarget.Rejected)
    }
    @Test fun notLoggedInOrNotUrl() {
        assertTrue(parseScan("https://yumeiro.example.com/?qr=abc", null) is ScanTarget.Rejected)
        assertTrue(parseScan("hello world", host) is ScanTarget.Rejected)
        assertTrue(parseScan("javascript:alert(1)", host) is ScanTarget.Rejected)
        assertTrue(parseScan("WIFI:S:x;T:WPA;P:y;;", host) is ScanTarget.Rejected)
    }
    @Test fun openChatAndWorkspace() {
        assertEquals(ScanTarget.Chat("0d4e-11"), parseScan("https://yumeiro.example.com/?open=chat:0d4e-11", host))
        assertEquals(ScanTarget.Chat("0d4e-11"), parseScan("https://yumeiro.example.com/?open=chat%3A0d4e-11", host))
        assertEquals(ScanTarget.Workspace("f661f00f-386f"), parseScan("http://YUMEIRO.example.com:8799/?open=workspace:f661f00f-386f", host))
        assertTrue(parseScan("https://yumeiro.example.com/?open=chat:", host) is ScanTarget.Rejected)
        assertTrue(parseScan("https://yumeiro.example.com/", host) is ScanTarget.Rejected)
    }

    /** 模拟 CameraX：灰度平面每行有补位（rowStride > width），ZXing 要能照样解出来。 */
    @Test fun decodesQrFromPaddedLuminancePlane() {
        val text = "https://yumeiro.example.com/?qr=CjN2rhWNzg28gSEWq-mFJQ"
        val size = 400
        val matrix = QRCodeWriter().encode(text, BarcodeFormat.QR_CODE, size, size, mapOf(EncodeHintType.MARGIN to 4))
        val rowStride = size + 24; val data = ByteArray(rowStride * size) { 0x80.toByte() }
        for (y in 0 until size) for (x in 0 until size) data[y * rowStride + x] = if (matrix[x, y]) 0 else 0xFF.toByte()
        val reader = MultiFormatReader().apply { setHints(mapOf(DecodeHintType.POSSIBLE_FORMATS to listOf(BarcodeFormat.QR_CODE), DecodeHintType.TRY_HARDER to true)) }
        val source = PlanarYUVLuminanceSource(data, rowStride, size, 0, 0, size, size, false)
        assertEquals(text, reader.decodeWithState(BinaryBitmap(HybridBinarizer(source))).text)
        // 旋转 90° 也能解（竖屏时传感器画面是横的）
        val rot = ByteArray(rowStride * size) { 0x80.toByte() }
        for (y in 0 until size) for (x in 0 until size) rot[x * rowStride + (size - 1 - y)] = data[y * rowStride + x]
        reader.reset()
        assertEquals(text, reader.decodeWithState(BinaryBitmap(HybridBinarizer(PlanarYUVLuminanceSource(rot, rowStride, size, 0, 0, size, size, false)))).text)
    }
}
