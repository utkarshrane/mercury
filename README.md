# CALL IT

A multiplayer bluff-dice game for 2–6 players. Everyone joins the same table with a room code from a phone or laptop. No accounts and no install.

## Play

```bash
npm install
npm start
```

Open the localhost URL printed in the terminal. Phones on the same Wi-Fi should use one of the network addresses printed under it. Copy the invite link from the lobby so it points at that address, not at `localhost`.

## Rules

Each player hides five dice. On your turn, bid how many of one face are on the whole table, or call the last bid a lie. A false bid costs the bidder a die. A true bid costs the caller a die. The last player with any dice wins. Ones are wild, except during a bid of ones or a Palifico round (anyone on their last die). The in-game rules cover the raise ladder with examples.

## Deploy

The app is one Node server. Set `PORT` if the host requires it, and use `npm start` as the start command on Render, Railway, or Fly. Behind a public hostname, the invite link uses that hostname automatically.
