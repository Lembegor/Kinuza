FROM python:3.12-slim
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY page.py server.py test_page.py ./
RUN useradd --uid 10002 --no-create-home share
USER share
CMD ["python", "server.py"]
