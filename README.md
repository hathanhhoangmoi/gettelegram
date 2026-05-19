# Telegram Selective Media Downloader

Ứng dụng web cục bộ để duyệt nhóm/kênh Telegram mà tài khoản của bạn có quyền xem, chọn từng ảnh/video, rồi tải về máy.

## Chuẩn bị

1. Lấy `api_id` và `api_hash` tại <https://my.telegram.org/apps>.
2. Cài thư viện:

```bash
python3 -m pip install -r requirements.txt
```

3. Chạy app:

```bash
python3 app.py
```

4. Mở trình duyệt tại:

```text
http://127.0.0.1:8787
```

## Deploy lên Render

Repo đã có sẵn `render.yaml` và `runtime.txt` để deploy dạng Web Service trên Render.

1. Đẩy thư mục này lên GitHub/GitLab.
2. Vào Render, chọn **New > Blueprint** hoặc **New > Web Service** và trỏ tới repo.
3. Nếu dùng Blueprint, Render sẽ đọc `render.yaml`.
4. Khi Render hỏi biến môi trường `WEB_PASSWORD`, nhập một mật khẩu mạnh. Tài khoản mặc định là `admin`.
5. Sau khi deploy xong, mở URL dạng `https://...onrender.com` trên điện thoại.

Ghi chú khi deploy:

- App bind theo `HOST=0.0.0.0` và biến `PORT` do Render cấp.
- `DATA_DIR=/opt/render/project/src/data` dùng để gom session/cache/downloads vào một thư mục.
- Access key được đọc từ `access_keys.txt` ở root dự án. Người dùng phải nhập key hợp lệ trước khi trình duyệt được tải logic app và gọi API.
- Render free có filesystem tạm; nếu muốn giữ session Telegram và file tải về sau restart/redeploy, hãy gắn Persistent Disk và đặt mount path trỏ tới thư mục `data`.
- Không nên để `WEB_PASSWORD` trống khi deploy public.

## Cách dùng

1. Nhập `api_id`, `api_hash`, số điện thoại Telegram.
2. Nhập mã xác thực Telegram gửi về app Telegram.
3. Nếu tài khoản bật mật khẩu 2FA, nhập thêm mật khẩu.
4. Chọn nhóm/kênh.
5. Click thumbnail để xem ảnh/video lớn.
6. Tick từng ảnh/video muốn tải và bấm `Download selected`.

File tải về nằm trong thư mục `downloads/`.

## Ghi chú

- App chỉ chạy cục bộ trên máy bạn.
- Phiên đăng nhập được lưu ở file `telegram_downloader.session` để lần sau không cần đăng nhập lại.
- Công cụ này không vượt quyền truy cập. Nó chỉ tải nội dung mà tài khoản Telegram của bạn đã xem được.
