def main():
    import uvicorn
    uvicorn.run("fabryka_track.api:app", host="0.0.0.0", port=8000, reload=False)

