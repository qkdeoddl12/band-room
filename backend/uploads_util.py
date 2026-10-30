"""이미지 업로드 — 티켓 배경과 정모 사진이 같은 검사를 쓴다.

검사를 복사해두면 한쪽만 느슨해진다. 여기 한 곳에만 둔다.
"""
from fastapi import HTTPException, UploadFile
import os
import secrets

UPLOAD_DIR = os.getenv("UPLOAD_DIR", "/app/uploads")
# MAX_UPLOAD_MB=0 이면 크기 제한 없음. 기본 25MB (요즘 폰 사진이 3~12MB).
MAX_UPLOAD_MB = int(os.getenv("MAX_UPLOAD_MB", "25"))
MAX_UPLOAD_BYTES = MAX_UPLOAD_MB * 1024 * 1024
CHUNK = 1024 * 1024

# content_type -> (확장자, 매직 넘버). 클라이언트가 보내는 content_type 은 힌트일 뿐이고
# 실제 판단은 매직 넘버가 한다 — 이름만 바꾼 실행 파일이 통과하지 못하게.
ALLOWED_IMAGES = {
    "image/jpeg": (".jpg", [b"\xff\xd8\xff"]),
    "image/png": (".png", [b"\x89PNG\r\n\x1a\n"]),
    "image/webp": (".webp", [b"RIFF"]),
}


async def save_image(file: UploadFile) -> tuple:
    """업로드된 이미지를 저장하고 (공개 주소, 파일명, 바이트 수) 를 돌려준다.

    - content-type 과 매직 넘버를 **둘 다** 본다
    - 원본 파일명은 절대 쓰지 않는다 (경로 탐색 방지)
    - 조각내어 쓴다 — 큰 파일도 메모리를 먹지 않는다
    - 중간에 끊기면 반쪽 파일을 지운다
    """
    if file.content_type not in ALLOWED_IMAGES:
        raise HTTPException(400, "JPG · PNG · WEBP 이미지만 업로드할 수 있습니다.")

    ext, magics = ALLOWED_IMAGES[file.content_type]

    head = await file.read(16)
    if not head:
        raise HTTPException(400, "빈 파일입니다.")
    if not any(head.startswith(m) for m in magics):
        raise HTTPException(400, "이미지 파일이 아닙니다.")

    name = secrets.token_hex(16) + ext
    os.makedirs(UPLOAD_DIR, exist_ok=True)
    path = os.path.join(UPLOAD_DIR, name)

    size = len(head)
    try:
        with open(path, "wb") as f:
            f.write(head)
            while chunk := await file.read(CHUNK):
                size += len(chunk)
                if MAX_UPLOAD_BYTES and size > MAX_UPLOAD_BYTES:
                    raise HTTPException(
                        413, f"이미지는 {MAX_UPLOAD_MB}MB 이하만 업로드할 수 있습니다."
                    )
                f.write(chunk)
    except Exception:
        if os.path.exists(path):
            os.remove(path)
        raise

    return f"/uploads/{name}", name, size
