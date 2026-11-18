---
title: Reading live Find My locations on macOS
description: Which sources give people, device and AirTag locations for a custom map, what works in Nov 2026, and the recommended architecture.
---

# Reading live Find My locations on macOS

Researched 2026-11-18 on Tommy's Mac (macOS **26.7.1**, build 25G241, SIP enabled).

**Gist:** Apple has no public Find My API. There are three working sources, and each covers a different kind of target:

| Target | Best source | Needs | Freshness |
|---|---|---|---|
| **People** (friends + family who share location) | Decrypted `LocalStorage.db` of `findmylocateagent` on this Mac | One-time key extraction with SIP + AMFI off | Daemon writes it in the background; seconds to minutes |
| **Devices** (own + Family Sharing iPhones, Macs, Watches) | iCloud web API via `pyicloud` (timlaing fork) | Apple ID password + 2FA once, token ~2 months | ~1-5 min server-side, `locate=True` forces a fix |
| **AirTags / items** | Decrypted `Items.data` cache, or `FindMy.py` with exported AirTag keys | Same key extraction as people, or a key export | Minutes (crowd-sourced reports) |
| **Real-time GPS tracks** (fallback) | OwnTracks / Overland app on each phone pushing to a local server | Each person installs the app and agrees | 1-30 s |

## 1. Local Find My cache files

What exists on this Mac (read-only check):

```
~/Library/Caches/com.apple.findmy.fmipcore/
  Devices.data  FamilyMembers.data  ItemGroups.data  Items.data  Owner.data  SafeLocations.data
~/Library/Caches/com.apple.findmy.fmfcore/FriendCacheData.data
~/Library/Group Containers/group.com.apple.findmy.findmylocateagent/Library/Application Support/
  LocalStorage.db (+ -wal, last written 2026-11-17 02:13, so the daemon keeps writing)
```

Every `.data` file is a binary plist `{ signature, encryptedData }` (verified with `xxd`):

```
bplist00 ... Ysignature ]encryptedData O.@ ...
```

**Encryption** (since macOS 14.4): ChaCha20-Poly1305, `encryptedData = nonce(12) + ciphertext + tag(16)`. The 256-bit key is in the Keychain item of `FMIPDataManager` / `FMFDataManager`, readable only by Apple's Find My processes. `LocalStorage.db` is a SQLite file encrypted page by page with Apple's `sqliteCodecCCCrypto` (AES-256 keystream XOR, 32-byte key).

**Key extraction works, but only with SIP + AMFI off once.** `findmy-key-extractor` attaches `lldb` to the Find My processes, restarts them and captures all three keys. Tested on macOS 26.5.2 Apple Silicon. Keys stay valid after you re-enable SIP and reboot.

| Repo | What |
|---|---|
| https://github.com/manonstreet/findmy-key-extractor | Extracts `FMIPDataManager.bplist`, `FMFDataManager.bplist`, `LocalStorage.key` (needs SIP+AMFI off) |
| https://github.com/manonstreet/FindMySyncPlus | Swift menu bar app. Decrypts caches + `LocalStorage.db`, publishes devices, items **and friends** to Home Assistant. Pushed 2026-11-09, best reference code |
| https://github.com/PnutCN/findmy-cache-decryptor | Python decryptor for the `.data` files, original reverse engineering |
| https://github.com/Pnut-GGG/FMIPDataManager-extractor | Older key extractor |
| https://github.com/MartinPham/FindMySync | Original app, broken since 14.4 |

Important details from the FindMySync+ source:

- **Friend live coordinates are not in the `.data` caches.** They are only in `LocalStorage.db`, which needs macOS 15+. `FriendCacheData.data` only holds friend names (DSID to name).
- **Family members appear twice**: as devices in `Devices.data` and as friends in `LocalStorage.db`. Dedupe by DSID.
- `LocalStorage.db` lives in the Group Container path above **or** in `$(getconf DARWIN_USER_DIR)com.apple.findmy.findmylocateagent/`. On this Mac it is the Group Container. Check both.
- **The FMIP `.data` caches only refresh while the Find My app runs.** On this Mac they were last written 2026-11-03. FindMySync+ opens Find My hidden (`NSWorkspace.OpenConfiguration` with `hides = true`, `activates = false`), waits ~10 s, then terminates it (`Helpers/FindMyRefresher.swift`). This does not steal focus.
- Apple rotates device UUIDs. Match by name/alias, not by id.
- Reading these paths needs **Full Disk Access** for the reader process.

## 2. iCloud web APIs (pyicloud)

- Maintained fork: https://github.com/timlaing/pyicloud (PyPI `pyicloud` 2026.11.2, released 2026-11-13). The original `picklepete/pyicloud` is dead.
- **Find My iPhone works** with 2FA: own devices, plus Family Sharing devices with `with_family=True`. Endpoint `fmipservice/client/web/refreshClient`.
- **Find My Friends (`fmf`) is gone.** Apple removed the web endpoint around 2022-2023, and the fork has no `fmf` service anymore. iCloud.com Find Devices shows **no people and no AirTags**.
- Session: cookies + trust token saved in a cookie dir. Re-auth with a 2FA code about every **2 months**. Keep one long-lived process; do not log in on every poll.
- Rate limits: undocumented. Default background refresh in the fork is 5 min, minimum 1 s. Polling every 30-60 s without `locate` is fine in practice. `locate=True` wakes the device GPS (battery cost); use it on demand, not on every poll.

```python
# uv add pyicloud
from pyicloud import PyiCloudService

api = PyiCloudService("tommy@example.com", password, cookie_directory="./.icloud", with_family=True)
if api.requires_2fa:
    api.validate_2fa_code(input("2FA code: "))
    api.trust_session()

for d in api.devices:
    loc = d.location  # dict or None
    # {latitude, longitude, horizontalAccuracy, altitude, timeStamp (ms), positionType,
    #  isOld, isInaccurate, floorLevel}
    print(d["name"], d["deviceDisplayName"], d["batteryLevel"], loc)
```

Home Assistant's built-in iCloud integration and iCloud3 use pyicloud, so they have the same limits: devices only, no people, no AirTags.

## 3. FindMy.py (AirTags)

https://github.com/malmeloo/FindMy.py (3.4k stars, v0.10.2 on 2026-09-14).

- Fetches and decrypts **crowd-sourced location reports** for official AirTags, iDevices and OpenHaystack tags. Cross-platform, built-in local anisette (no anisette server needed), SMS and trusted-device 2FA.
- It needs the **accessory private keys**. For real AirTags you must export them from Apple's `searchpartyd` beacon records (`OwnedBeacons/*.record`, decrypted with the Keychain `BeaconStore` key). On current macOS that key is not readable by user processes, so you need either SIP off, or a throwaway macOS VM that signs into iCloud Keychain: https://github.com/tieo/afm-key-extractor (Linux + KVM, automated Sonoma VM).
- **No people support.** For your own iPhone/Mac it can work in theory, but pyicloud is simpler.
- Report shape: `latitude`, `longitude`, `confidence`/accuracy, `timestamp`, `status` (battery bits).

```python
from findmy import FindMyAccessory
# account login helper: examples/_login.py, session saved to account.json
airtag = FindMyAccessory.from_plist("airtag.plist")   # examples/plist_to_json.py
loc = acc.fetch_location([airtag])[airtag]
```

Since the key extraction in section 1 already decrypts `Items.data` (which has AirTag locations), FindMy.py is only worth it if you want AirTags **without** opening the Find My app, or on a non-Mac server.

## 4. Other options

| Option | Verdict |
|---|---|
| Accessibility scraping of Find My.app (cua-driver) | **No.** The People and Devices lists show name, place label and distance, not coordinates. Fragile, and it needs the window. |
| Shortcuts | **No.** "Get Current Location" gives only the device running it. Personal automations cannot run every N seconds, and there is no action for a friend's location. |
| OwnTracks (https://owntracks.org) / Overland (https://github.com/aaronpk/Overland-iOS) | **Yes, for real-time tracks.** Each phone POSTs JSON (OwnTracks) or GeoJSON batches (Overland) to your HTTP endpoint. Needs the app on each phone, background location permission and a reachable URL (Tailscale or a tunnel). |
| Home Assistant iCloud / iCloud3 | Devices only (pyicloud). FindMySync+ can feed HA, but we do not need HA. |

## 5. Recommended architecture

```
┌────────────────────────── Tommy's Mac ──────────────────────────────────────────────┐
│                                                                                     │
│  findmylocateagent ──writes──▶ LocalStorage.db (encrypted) ──┐                      │
│  Find My.app (opened hidden ~10s every 1-2 min) ──▶ Devices.data, Items.data ──┐    │
│                                                     │                          │    │
│                                                     ▼                          ▼    │
│                          poller (FDA, keys from extractor) ──decrypt──▶ points      │
│  pyicloud session (cookie dir) ──refreshClient every 60s──────────────────▶ points  │
│                                                                              │      │
│  OwnTracks / Overland POST /ingest (optional) ───────────────────────────────▶│      │
│                                                                              ▼      │
│                                      merge by person/device, newest wins ──▶ SSE ──▶ web map
└─────────────────────────────────────────────────────────────────────────────────────┘
```

- **People:** decrypted `LocalStorage.db`, read every 10-30 s (it is a local file). Copy the db + `-wal` + `-shm` to a temp dir before opening, never open Apple's file in place. Port the page decryption from `LocalStorageDecryptor.swift`.
- **Devices:** pyicloud every 60 s with `with_family=True`; `locate=True` only when the user clicks a device. Use decrypted `Devices.data` as a second source.
- **AirTags:** decrypted `Items.data`, refreshed by opening Find My hidden every 1-2 min.
- **Real-time steps:** OwnTracks (HTTP mode) or Overland for people who opt in.

Normalized point shape for the map:

```ts
type Point = {
  id: string            // alias, stable across Apple UUID rotation
  kind: 'person' | 'device' | 'item'
  name: string
  lat: number
  lon: number
  accuracyM: number     // horizontalAccuracy
  timestamp: number     // ms epoch of the fix, not of the poll
  source: 'localstorage' | 'fmip-cache' | 'icloud' | 'owntracks'
  battery?: number
}
```

## What Tommy must do manually

1. **Key extraction (once):** boot to Recovery, `csrutil disable`, then `sudo nvram boot-args="amfi_get_out_of_my_way=1"`, run `findmy-key-extractor/extract.sh`, then undo both in Recovery (`nvram -d boot-args`, `csrutil enable`). Store keys in Sigillo or the Keychain, never in the repo.
2. **Full Disk Access** for the poller binary (or the terminal that runs it).
3. **iCloud login with 2FA** for pyicloud once, then again about every 2 months.
4. **OwnTracks/Overland** (optional): install on each phone and set the endpoint URL.

## Privacy and ToS

- All of this is unofficial and against the spirit of Apple's terms. Apple can break it with any macOS update (new key location, new encryption). The iCloud account could be flagged for automated access; keep polling moderate.
- People only appear if they already share their location with Tommy in Find My. Still tell them the locations go into a custom map, and keep the data local (no cloud relay, no long-term history unless they agree).
- Disabling SIP + AMFI is a real security risk while it is off. Do it once, offline if possible, and turn it back on right away.
