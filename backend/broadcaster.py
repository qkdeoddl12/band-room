import asyncio
import json
from typing import Any, Optional


class Broadcaster:
    def __init__(self) -> None:
        self._subscribers: list[asyncio.Queue] = []
        self._loop: Optional[asyncio.AbstractEventLoop] = None

    def attach_loop(self, loop: asyncio.AbstractEventLoop) -> None:
        self._loop = loop

    async def subscribe(self) -> asyncio.Queue:
        q: asyncio.Queue = asyncio.Queue()
        self._subscribers.append(q)
        return q

    async def unsubscribe(self, q: asyncio.Queue) -> None:
        if q in self._subscribers:
            self._subscribers.remove(q)

    def publish(self, event: str, data: Any) -> None:
        if self._loop is None:
            return
        msg = json.dumps({"event": event, "data": data}, default=str)

        def _fanout() -> None:
            for q in list(self._subscribers):
                try:
                    q.put_nowait(msg)
                except Exception:
                    pass

        self._loop.call_soon_threadsafe(_fanout)


broadcaster = Broadcaster()
