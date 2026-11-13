FROM python:3.12-slim
RUN pip install --no-cache-dir playwright==1.49.0
COPY check.py /check.py
USER 1000:1000
CMD ["python", "/check.py"]
