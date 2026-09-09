# FireCommander

A web-based keyboard game where a perception robot finds fires and an action robot extinguishes them.

## Play From This Folder

On macOS, double-click:

```text
Play FireCommander.command
```

It starts the local server and opens the game in your default browser. If port 8000 is busy, it tries 8001, then 8002, and so on.

You can also start the server manually:

Start a local web server:

```bash
python3 -m http.server 8000
```

Then open:

[http://localhost:8000/](http://localhost:8000/)

## Controls

- Arrow keys: move the perception robot
- Right Shift: mark a fire found by the perception robot
- WASD: move the action robot
- Left Shift: extinguish a marked fire under the action robot

## Automation

Before starting a mission, choose any automation options you want:

- Automate Perception Agent
- Automate Action Agent

You can automate either robot, both robots, or neither robot. Press Start Mission to begin the timer after choosing the difficulty and automation settings. The automation policy is the same on Easy, Moderate, and Hard.

Win by extinguishing all fires before time runs out.
