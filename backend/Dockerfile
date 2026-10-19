FROM python:3.11-slim

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

EXPOSE 8000

# --proxy-headers 가 없으면 역방향 프록시 뒤에서 request.base_url 이 내부 주소가 된다.
# og 태그에 그 주소가 박혀 나가면 카톡 미리보기가 이미지를 못 가져온다.
# 믿는 프록시는 docker 브리지 대역뿐이다 — DSM 프록시가 들어오는 자리. "*" 로 두면
# 아무나 X-Forwarded-For 를 적어 감사 로그 IP 를 꾸미고 로그인 잠금을 피한다.
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000", \
     "--proxy-headers", "--forwarded-allow-ips", "127.0.0.1,172.16.0.0/12"]
