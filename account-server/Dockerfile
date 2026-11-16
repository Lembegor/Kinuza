FROM python:3.12-slim
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY google.py store.py party.py server.py test_account.py test_party.py ./
RUN useradd --uid 10003 --no-create-home account && mkdir -p /data && chown account /data
USER account
CMD ["python", "server.py"]
