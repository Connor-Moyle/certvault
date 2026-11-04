FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    TZ=Australia/Perth \
    CV_DATA_DIR=/data \
    TMPDIR=/data/tmp

RUN apt-get update \
 && apt-get install -y --no-install-recommends tesseract-ocr tesseract-ocr-eng tesseract-ocr-osd poppler-utils tzdata \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY app ./app

# 568 = TrueNAS SCALE "apps" user/group, so files on your dataset get sane ownership
RUN groupadd -g 568 apps 2>/dev/null || true \
 && useradd -u 568 -g 568 -M -s /usr/sbin/nologin apps 2>/dev/null || true \
 && mkdir -p /data && chown 568:568 /data
USER 568:568

VOLUME /data
EXPOSE 8080
HEALTHCHECK --interval=60s --timeout=5s --start-period=20s CMD python -c "import urllib.request;urllib.request.urlopen('http://127.0.0.1:8080/healthz')" || exit 1

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8080", "--proxy-headers", "--forwarded-allow-ips", "*", "--no-server-header"]
