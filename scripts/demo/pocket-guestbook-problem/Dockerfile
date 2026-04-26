FROM python:3.12-alpine

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY app.py .
COPY templates ./templates
COPY 40-cstrike-bootstrap.sh /usr/local/bin/40-cstrike-bootstrap.sh

RUN chmod +x /usr/local/bin/40-cstrike-bootstrap.sh \
    && mkdir -p /app/data

ENV PORT=8000
EXPOSE 8000

CMD ["/bin/sh", "-c", "/usr/local/bin/40-cstrike-bootstrap.sh && python app.py"]
