def main():
    import uvicorn
    from .settings import settings

    uvicorn.run("fabryka_track.api:app",
                host="127.0.0.1" if settings.local_login else "0.0.0.0",
                port=8000, reload=False)

