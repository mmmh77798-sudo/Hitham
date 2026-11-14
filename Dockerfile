FROM python:3.13-slim
ENV PORT=8083 PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
WORKDIR /app
COPY server.py client.html questions.json ./
EXPOSE 8083
CMD ["python", "server.py"]
