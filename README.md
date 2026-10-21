# PowerFlow HUD ⚡
### Interactive N-Bus Power Flow & Voltage Stability Visualizer

[![Python](https://img.shields.io/badge/Python-3.10%2B-blue.svg?logo=python&logoColor=white)](https://www.python.org/)
[![FastAPI](https://img.shields.io/badge/FastAPI-0.104.1-009688.svg?logo=fastapi&logoColor=white)](https://fastapi.tiangolo.com/)
[![NumPy](https://img.shields.io/badge/NumPy-1.26.2-013243.svg?logo=numpy&logoColor=white)](https://numpy.org/)
[![HTML5 Canvas](https://img.shields.io/badge/HTML5-Canvas%2060FPS-E34F26.svg?logo=html5&logoColor=white)](https://developer.mozilla.org/en-US/docs/Web/API/Canvas_API)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

> **PowerFlow HUD** is an interactive, web-based engineering HUD designed to teach power system physics through visual intuition. It bridges pure theoretical matrix mathematics ($Y_{\text{bus}}$, Jacobian, Newton-Raphson iteration) with intuitive physical analogies, real-time particle dynamics, and dynamic continuation power flow analysis.

---

## 🌟 Key Features

### 1. Dynamic N-Bus Graphical Canvas & Editor
- **Interactive Topology Builder**: Click, drag, and connect buses directly on a hardware-accelerated 60 FPS HTML5 canvas.
- **Full Bus Type Support**:
  - **Slack Bus (Swing)**: Sets reference angle ($\theta = 0^\circ$) and absorbs system mismatch.
  - **PV Generator Bus**: Regulates voltage magnitude $|V|$ and injects real power $P$.
  - **PQ Load Bus**: Represents active ($P_L$) and reactive ($Q_L$) power demands.
- **Transmission Line Parameterization**: Configure branch resistance ($R$), reactance ($X$), shunt charging susceptance ($B/2$), tap ratio ($a$), and MVA ratings.
- **$N-1$ Contingency / Line Outage Simulation**: Toggle line status with a single click to immediately observe real-time power redistribution and voltage sags.
- **Built-in Presets**:
  - `2-Bus`: Infinite bus feeding a variable load through a transmission line.
  - `3-Bus`: Classic triangle meshed power network with PV, PQ, and Slack nodes.
  - `5-Bus IEEE`: Standard test system illustrating inter-area power transfers.
  - `Blank`: Clean-slate canvas for building arbitrary topologies from scratch.

### 2. Physical Intuition Visuals (For Students & Engineers)
- **Voltage Magnitude ($|V|$) as Fluid Pressure**: Dynamic liquid gauges on bus nodes rise or sag in real time with per-unit voltage.
- **Voltage Phase Angle ($\theta$) Phasor Dial**: Rotating phasor dials on nodes show angular displacement relative to the reference slack bus.
- **Real-Time Particle Dynamics**:
  - **Flow Velocity & Direction**: Driven by Active Power ($P$) magnitude and direction ($P$ flows from higher phase angle to lower phase angle).
  - **Particle Glow Color**: Cyan for Inductive VARs ($Q > 0$), Magenta for Capacitive VARs ($Q < 0$).
  - **Thermal Line Stress Heatmap**: Transmission lines dynamically change color (Green $\to$ Yellow $\to$ Pulsing Red) as the $I^2 R$ thermal loading reaches line ratings.

### 3. "Under the Hood" Numerical Solver & Matrix Inspector
- **Live $Y_{\text{bus}}$ Admittance Matrix**: Dynamically assembles and visualizes the complex $N \times N$ matrix in conductance-susceptance ($G + jB$) format upon any network edit.
- **Interactive 4-Quadrant Jacobian Matrix ($J$)**:
  - $J_{11} = \frac{\partial P}{\partial \theta}$ (Sensitivity of real power to bus angles)
  - $J_{12} = \frac{\partial P}{\partial |V|}$ (Cross-coupling sensitivity)
  - $J_{21} = \frac{\partial Q}{\partial \theta}$ (Cross-coupling sensitivity)
  - $J_{22} = \frac{\partial Q}{\partial |V|}$ (Sensitivity of reactive power to bus voltage magnitude)
- **Newton-Raphson Step-by-Step Solver**: Step through iterations one-by-one ($k \to k+1$) to inspect state vectors, power mismatches ($\Delta P, \Delta Q$), and convergence trajectories.
- **Convergence Rate Graph**: Real-time logarithmic chart tracking the infinity norm of power mismatch $||\Delta P, \Delta Q||_\infty$ down to solver tolerance ($10^{-6}$).

### 4. Voltage Stability & P-V Nose Curves
- **Global System Load Scaling**: Scale total system loading from 0% to 300% to simulate heavy peak loading.
- **Automated P-V Nose Curve Generation**: Computes the nose curve for any selected load bus using continuation power flow.
- **Saddle-Node Bifurcation Detection**: Detects singularity of the power flow Jacobian (Maximum Power Transfer Point) and triggers a **"Voltage Collapse Impending"** alert HUD warning.

---

## 📐 Mathematical Formulation

### 1. Nodal Admittance Matrix ($Y_{\text{bus}}$)
For a system of $N$ buses, the bus admittance matrix elements are formulated as:
- **Off-diagonal terms**:
  $$Y_{ik} = -y_{ik} = -\left(\frac{1}{R_{ik} + jX_{ik}}\right)$$
- **Diagonal terms**:
  $$Y_{ii} = y_{ii0} + \sum_{k \neq i} \left(y_{ik} + j\frac{B_{ik}}{2}\right)$$

### 2. Power Flow Equations
At each bus $i$, net power injections must satisfy:
$$P_i = |V_i| \sum_{k=1}^N |V_k| \Big( G_{ik} \cos(\theta_i - \theta_k) + B_{ik} \sin(\theta_i - \theta_k) \Big)$$
$$Q_i = |V_i| \sum_{k=1}^N |V_k| \Big( G_{ik} \sin(\theta_i - \theta_k) - B_{ik} \cos(\theta_i - \theta_k) \Big)$$

### 3. Newton-Raphson Linearization
At iteration $k$, the mismatch equations are solved via the Jacobian matrix:
$$\begin{bmatrix} \Delta P \\ \Delta Q \end{bmatrix} = \begin{bmatrix} J_{11} & J_{12} \\ J_{21} & J_{22} \end{bmatrix} \begin{bmatrix} \Delta \theta \\ \frac{\Delta |V|}{|V|} \end{bmatrix}$$
State updates:
$$\theta^{(k+1)} = \theta^{(k)} + \Delta \theta, \quad |V|^{(k+1)} = |V|^{(k)} + \Delta |V|$$

---

## 🛠️ Architecture & Tech Stack

```
CAPSA/
├── backend/
│   ├── app.py              # FastAPI server, REST API endpoints, static file mounting
│   ├── power_flow.py       # Numerical engine: Y-Bus, Newton-Raphson, Jacobian, P-V continuation
│   ├── requirements.txt    # Python package dependencies
│   └── venv/               # Python virtual environment
├── frontend/
│   ├── index.html          # Semantic HUD UI structure & layout
│   ├── css/
│   │   └── style.css       # Futuristic Cyberpunk glassmorphism design tokens & styles
│   └── js/
│       └── app.js          # HTML5 Canvas 60FPS renderer, particle system, state management
└── README.md
```

- **Backend**:
  - [Python 3.10+](https://www.python.org/)
  - [FastAPI](https://fastapi.tiangolo.com/): High-performance asynchronous API framework
  - [NumPy](https://numpy.org/): Vectorized matrix operations and linear solvers
  - [Uvicorn](https://www.uvicorn.org/): Lightning-fast ASGI web server
- **Frontend**:
  - **HTML5 Canvas**: Custom rendering engine for nodes, branch lines, phasor dials, and particle flows.
  - **Vanilla CSS**: Custom Cyberpunk HUD theme with neon cyan (`#00ffff`) & magenta (`#ff00ff`), glassmorphism panels, and responsive grid layouts.
  - **Vanilla ES6+ JS**: Zero external frontend dependencies or heavy build steps—instant load and high performance.

---

## 🚀 Quick Start Guide

### Prerequisites
- Python 3.10 or higher
- Modern web browser (Chrome, Firefox, Safari, Edge)

### 1. Clone or Open the Workspace
```bash
cd /path/to/CAPSA
```

### 2. Set Up Python Virtual Environment
```bash
# Create virtual environment if not already present
python3 -m venv backend/venv

# Activate virtual environment
# On macOS / Linux:
source backend/venv/bin/activate
# On Windows:
# backend\venv\Scripts\activate
```

### 3. Install Dependencies
```bash
pip install -r backend/requirements.txt
```

### 4. Launch the Server
```bash
python backend/app.py
```
*Alternatively, using uvicorn directly:*
```bash
uvicorn backend.app:app --host 0.0.0.0 --port 8000 --reload
```

### 5. Access the Visualizer
Open your browser and navigate to:
```
http://localhost:8000
```

---

## 📡 REST API Reference

The backend exposes a full suite of REST endpoints for programmatic access and external integrations:

| Method | Endpoint | Description |
|:-------|:---------|:------------|
| `GET` | `/api/system` | Retrieve full system state (buses, lines, losses, Y-Bus, Jacobian, convergence). |
| `POST` | `/api/preset/{preset_name}` | Load a preset topology (`2bus`, `3bus`, `5bus`, or `blank`). |
| `POST` | `/api/bus` | Add a new bus with specified type and coordinates. |
| `PUT` | `/api/bus/{bus_id}` | Update bus parameters ($P_{\text{gen}}, Q_{\text{gen}}, P_{\text{load}}, Q_{\text{load}}, |V|$). |
| `DELETE` | `/api/bus/{bus_id}` | Remove a bus and all connected lines. |
| `POST` | `/api/line` | Add a transmission line between two buses. |
| `PUT` | `/api/line/{line_id}` | Update transmission line parameters ($R, X, B, \text{tap}, \text{rating}$). |
| `DELETE` | `/api/line/{line_id}` | Remove a transmission line. |
| `POST` | `/api/line/{line_id}/toggle` | Toggle line status (simulate tripping / line outage). |
| `POST` | `/api/solver/step` | Execute a single Newton-Raphson iteration step ($k+1$). |
| `POST` | `/api/solver/solve` | Run solver to full convergence ($||\Delta|| < \epsilon$). |
| `POST` | `/api/solver/reset` | Reset solver to flat start ($|V| = 1.0\text{ p.u.}, \theta = 0^\circ$). |
| `POST` | `/api/solver/settings` | Update solver tolerance and maximum iterations. |
| `POST` | `/api/analysis/pv-curve` | Compute P-V nose curve for a designated load bus. |
| `POST` | `/api/analysis/scale-load` | Scale all network loads by a factor and re-solve. |
| `GET` | `/api/ybus` | Retrieve admittance matrix in dense format. |

---

## 🎮 Interactive Controls & Shortcuts

| Action | Control | Description |
|:-------|:--------|:------------|
| **Select / Drag Node** | Click & Drag | Move buses anywhere on the canvas; connected lines adapt dynamically. |
| **Inspect Element** | Click Bus or Line | Opens the parameter inspector in the sidebar. |
| **Pan Canvas** | Right-Click Drag | Pans the viewing area across the grid. |
| **Zoom Canvas** | Mouse Wheel / HUD Buttons | Zoom in (`+`), Zoom out (`-`), or Reset view (`⊞`). |
| **Step Solver** | `Step (k+1)` Button | Iteratively observes error reduction step by step. |
| **Auto-Solve** | Toggle in Solver Tab | Re-computes power flow automatically upon any topology or parameter change. |
| **N-1 Contingency** | Click Line Outage Toggle | Tests grid reliability when specific branches fail. |

---

## 📄 License
This project is licensed under the MIT License — see the [LICENSE](LICENSE) file for details.
