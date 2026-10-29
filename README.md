# Run All Around 🏃

**Live:** https://christer-eriksson.github.io/all-over-the-place/

Mark an area on the map, pull every street from OpenStreetMap, and get the shortest
closed loop that runs every street at least once (the Chinese Postman / Route Inspection
Problem). Export it as a GPX course for Garmin Connect.

## Run it

No build step. Serve the folder with any static server:

    python3 -m http.server 8080

then open http://localhost:8080. Opening `index.html` directly also works in most browsers.

## Features

- Draw the area with the mouse: rectangle or polygon (Enter to finish, Esc to cancel).
- Streets come from the Overpass API; choose whether service roads, paths/trails, sidewalks and steps count.
- Click a street for a menu: **Run it**, **Avoid** (covered once if it has to be, never used to double back) or **Block** (never run). Shift-click blocks or unblocks in one go.
- Blocking a piece also drops anything it cuts off, such as the rest of a dead-end branch. These show as faded red and come back when you unblock.
- **Cut a passage** makes a street impassable at one exact spot, for a fence, a closed gate or a section you don't want to run. Each side becomes a dead end, and you can block either side. Click the ⛔ marker to remove a cut.
- Toggle dead-end streets on/off.
- Draw your own paths (shortcuts across a field, a gate, a beach). The ends snap to the closest street within 30 m, splitting it if needed.
- Set a start/finish point, or let the solver pick one.
- Stats: streets to cover, total run, repeated distance, estimated time from your pace, and a cue sheet.
- GPX download, one track, ready for Garmin Connect → Courses → Import.
- Area, blocks, avoids, cuts, custom paths and start are kept in `localStorage`.

## How the route is computed (js/graph.js)

1. Streets inside the area are chopped into edges between intersections, keeping full geometry.
2. Dead ends are peeled off iteratively (only used when the toggle is off); the largest connected component is kept.
3. Intersections with an odd number of streets are listed; Dijkstra gives the shortest path between every pair.
4. Odd intersections are paired up with a greedy matching improved by pair swaps (a fast approximation of minimum-weight perfect matching).
5. Streets along those pairings are duplicated (shown in orange = run twice) so every node has even degree.
6. Hierholzer's algorithm traces an Euler circuit starting at your start point.
