"""
wsgi.py — Entry point for Google App Engine
Gunicorn calls this file to start the app.
"""
from app import app, socketio

# GAE calls this
if __name__ == '__main__':
    socketio.run(app)
