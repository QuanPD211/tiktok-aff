# Tin tức + Popup chuyển hướng

## Chạy

```bash
npm install
npm start            # http://localhost:3000
```

Biến môi trường (tùy chọn): `PORT`, `SESSION_SECRET`, `ADMIN_USER`, `ADMIN_PASS` (chỉ dùng cho lần chạy đầu khi tạo database).

Admin: `http://localhost:3000/admin` — mặc định `admin` / `admin123`, đổi ngay trong **Cài đặt**.

## Chức năng

- **Bài viết**: thêm/sửa/xóa, soạn thảo rich text (upload ảnh), ảnh đại diện, mô tả (dùng cho thẻ Open Graph khi chia sẻ link).
- **Popup**: khi mở link bài viết, popup quảng cáo hiện ra; bấm bất kỳ đâu hoặc bấm nút tắt sẽ chuyển sang link đã cấu hình.
- **Link chuyển hướng**: link chung trong Cài đặt; mỗi bài có thể đặt link riêng (ưu tiên hơn link chung).
- **Thống kê**: lượt xem và lượt click popup cho từng bài.
- **Nguồn tin RSS** (`/admin/feeds`): lấy tin từ VnExpress, Kenh14 (thêm nguồn khác bằng link RSS). Nhập tin tạo **bài nháp** gồm tiêu đề, mô tả ngắn, ảnh và ghi nguồn — viết thêm nội dung riêng rồi mới đăng. Chỉ lấy tin khi bấm "Lấy tin mới ngay"; tin chưa nhập quá 1 ngày tự bị xóa.

Dữ liệu lưu ở `data/app.db` (SQLite), ảnh upload lưu ở `public/uploads/`.
