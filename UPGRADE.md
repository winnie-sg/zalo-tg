# Hướng dẫn Nâng cấp zalo-tg (Upgrade Guide)

Tài liệu này hướng dẫn chi tiết các bước nâng cấp từ các phiên bản cũ (chưa có Magika AI, gói bảo mật tệp và các bản vá hiệu năng/rò rỉ bộ nhớ) lên phiên bản mới nhất.

---

## 1. Tóm tắt các thay đổi quan trọng (What's New)

| Hạng mục | Phiên bản cũ | Phiên bản mới |
|---|---|---|
| **Bảo vệ tệp tin (File Security)** | Chỉ kiểm tra đuôi mở rộng (`.ext`) | Tích hợp **Google Magika AI** nhận diện tệp qua deep learning, phát hiện tệp giả mạo payload |
| **Cơ chế duyệt tệp khả nghi** | Không có (hoặc gây crash `zca-js`) | **Interactive Admin Approval Gateway**: Gửi thông báo kèm nút bấm Inline Telegram (`[✅ Tiếp tục]` / `[❌ Huỷ & Xoá]`) cho Admin duyệt |
| **Document Fallback** | Crash `Failed to get image metadata` | Tự động chuyển container sang tệp nhị phân (`forceDocFallback`) nếu ảnh bị đổi đuôi giả |
| **Hiệu năng & Bộ nhớ (Memory Leak Fix)** | Promise-chain logger giữ lại closure gây tăng RAM (~4GB sau 2 ngày) | **Batched Logger Queue** + Giới hạn cache 5,000 mục với TTL 2 ngày (RAM ổn định ~100–200MB) |
| **Thư viện hình ảnh** | `image-size` (có lỗ hổng DoS) | `@napi-rs/canvas` Rust-native (0 CVEs) |
| **Node.js Target** | Node 20.x | Node.js LTS 20.x & 22.x |

---

## 2. Yêu cầu hệ thống (System Requirements)

- **Node.js**: Phiên bản `>= 20.18.0` hoặc `>= 22.0.0` (Active LTS khuyến nghị: Node 22).
- **NPM**: `>= 10.0.0`.
- **RAM**: Tối thiểu 512MB RAM (Khuyến nghị cấp 1GB).

---

## 3. Các bước nâng cấp chi tiết

### Bước 1: Sao lưu cấu hình và dữ liệu hiện tại
Trước khi cập nhật, tạo bản sao lưu thư mục dữ liệu (`data/`) và tệp môi trường (`.env`):
```bash
# Trên Linux/macOS
cp .env .env.backup
cp -r data/ data_backup/

# Trên Windows PowerShell
Copy-Item .env .env.backup
Copy-Item -Recurse data/ data_backup/
```

---

### Bước 2: Cập nhật mã nguồn
Kéo mã nguồn mới nhất về thư mục dự án:
```bash
git pull origin main
```

---

### Bước 3: Cập nhật các gói phụ thuộc (Dependencies)
Cài đặt các gói mới (`magika`, cập nhật `axios`, `adm-zip` và loại bỏ `image-size`):
```bash
npm install
```

---

### Bước 4: Cập nhật tệp cấu hình `.env`
Mở tệp `.env` của bạn và bổ sung 2 biến cấu hình bảo mật mới (nếu chưa có):

```env
# ------------------------------------------------------------------------------
# FILE SECURITY & MAGIKA AI GATEWAY
# ------------------------------------------------------------------------------
# 1 = Bật kiểm tra tệp tin giả mạo bằng Google Magika AI (Khuyến nghị: 1)
# 0 = Tắt kiểm tra
MAGIKA_BLOCK_DISGUISED=1

# Ngưỡng tin cậy tối thiểu (từ 0.00 đến 1.00, mặc định: 0.80 tương đương 80%)
# Nếu độ tin cậy < 80% hoặc phát hiện sai loại tệp, bot sẽ tạm dừng và hỏi ý kiến Admin
MAGIKA_CONFIDENCE_THRESHOLD=0.80
```

---

### Bước 5: Biên dịch và chạy kiểm thử (Build & Verification)
Kiểm tra xem toàn bộ hệ thống đã tương thích và vượt qua kiểm thử:

```bash
# 1. Biên dịch mã TypeScript
npm run build

# 2. Chạy bộ kiểm thử tự động (98 tests)
npm test

# 3. Kiểm tra bảo mật gói phụ thuộc
npm run security:audit
```

---

### Bước 6: Khởi động lại dịch vụ

#### Chạy trực tiếp qua Node / PM2:
```bash
# Nếu chạy thông thường
npm start

# Nếu chạy qua PM2
pm2 restart zalo-tg
```

#### Nếu chạy qua Docker:
```bash
docker compose down
docker compose build --no-cache
docker compose up -d
```

---

## 4. Hướng dẫn sử dụng tính năng mới

### 1. Phê duyệt tệp khả nghi (Interactive Admin Approval)
Khi người dùng gửi một tệp bị đổi đuôi (ví dụ: tệp mã nguồn `.js` hoặc `.bat` nhưng đổi tên thành `hinh_anh.png`):
1. **Bot sẽ chặn gửi ngay lập tức**, không để `zca-js` bị crash.
2. Bot gửi thông báo trong Topic tương ứng trên Telegram kèm nút bấm `[✅ Tiếp tục]` và `[❌ Huỷ & Xoá]`.
3. **Chỉ Quản trị viên (Group Admin)** trên Telegram mới có quyền bấm nút duyệt.
4. Nếu duyệt, bot sẽ gửi an toàn dưới dạng file tài liệu (`document fallback`). Nếu bấm Huỷ hoặc sau **10 phút** không có phản hồi, tệp tạm sẽ tự động bị xóa sạch.

### 2. Tự động dọn dẹp bộ nhớ (Zero-Leak)
- Log hệ thống được ghi theo batch và giải phóng ngay khỏi RAM.
- Bộ nhớ đệm tin nhắn thu hồi (`recallNotifiedStore`) tự động dọn dẹp các mục quá **2 ngày tuổi**.
