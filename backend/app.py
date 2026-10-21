"""
FastAPI Backend Server for Power Flow Visualizer
=================================================
REST API endpoints for:
  - System topology management (buses, lines)
  - Y-Bus matrix retrieval
  - Newton-Raphson step-by-step solver
  - P-V nose curve computation
  - System analytics
"""

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse
from pydantic import BaseModel
from typing import Optional, Dict
import os

from power_flow import (
    PowerFlowEngine, Bus, Line, PRESETS,
    create_2bus_system, create_3bus_system, create_5bus_system
)

app = FastAPI(title="Power Flow Visualizer API", version="1.0.0")

# CORS for frontend
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Mount frontend static files
frontend_path = os.path.join(os.path.dirname(os.path.dirname(__file__)), "frontend")
if os.path.exists(frontend_path):
    app.mount("/static", StaticFiles(directory=frontend_path), name="static")

# Global engine instance
engine: PowerFlowEngine = create_3bus_system()


# ===== Pydantic Models =====

class BusCreate(BaseModel):
    bus_id: int
    bus_type: int = 2  # 0=Slack, 1=PV, 2=PQ
    v_mag: float = 1.0
    v_angle: float = 0.0
    p_gen: float = 0.0
    q_gen: float = 0.0
    p_load: float = 0.0
    q_load: float = 0.0
    q_min: float = -999.0
    q_max: float = 999.0
    x: float = 400.0
    y: float = 300.0


class BusUpdate(BaseModel):
    bus_type: Optional[int] = None
    v_mag: Optional[float] = None
    v_angle: Optional[float] = None
    p_gen: Optional[float] = None
    q_gen: Optional[float] = None
    p_load: Optional[float] = None
    q_load: Optional[float] = None
    q_min: Optional[float] = None
    q_max: Optional[float] = None
    x: Optional[float] = None
    y: Optional[float] = None


class LineCreate(BaseModel):
    line_id: int
    from_bus: int
    to_bus: int
    r: float = 0.01
    x: float = 0.1
    b: float = 0.0
    tap: float = 1.0
    rating: float = 2.0


class LineUpdate(BaseModel):
    r: Optional[float] = None
    x: Optional[float] = None
    b: Optional[float] = None
    tap: Optional[float] = None
    rating: Optional[float] = None
    is_active: Optional[bool] = None


class SolverSettings(BaseModel):
    tolerance: Optional[float] = None
    max_iterations: Optional[int] = None


class LoadScaling(BaseModel):
    factor: float = 1.0


class PVCurveRequest(BaseModel):
    bus_id: int
    steps: int = 60
    max_loading: float = 3.0


# ===== Frontend Serving =====

@app.get("/")
async def serve_index():
    index_path = os.path.join(frontend_path, "index.html")
    if os.path.exists(index_path):
        return FileResponse(index_path)
    return {"message": "Power Flow Visualizer API - Frontend not found"}


# ===== Topology Endpoints =====

@app.get("/api/system")
async def get_system():
    """Get complete system state."""
    engine.build_ybus()
    line_flows = engine.compute_line_flows()
    return {
        'buses': {str(bid): bus.to_dict() for bid, bus in engine.buses.items()},
        'lines': line_flows if line_flows else [line.to_dict() for line in engine.lines.values()],
        'ybus': engine.get_ybus_data(),
        'converged': engine.converged,
        'iteration': engine.iteration,
        'mismatch_history': engine.mismatch_history,
        'summary': engine.get_system_summary(),
        'jacobian': engine.jacobian_sub,
    }


@app.post("/api/preset/{preset_name}")
async def load_preset(preset_name: str):
    """Load a preset topology."""
    global engine
    if preset_name not in PRESETS and preset_name != 'blank':
        raise HTTPException(status_code=404, detail=f"Preset '{preset_name}' not found")

    if preset_name == 'blank':
        engine = PowerFlowEngine()
        engine.add_bus(Bus(1, Bus.SLACK, v_mag=1.05, v_angle=0.0, x=400, y=300))
    else:
        engine = PRESETS[preset_name]()

    engine.build_ybus()
    return await get_system()


@app.post("/api/bus")
async def add_bus(bus_data: BusCreate):
    """Add a new bus."""
    if bus_data.bus_id in engine.buses:
        raise HTTPException(status_code=400, detail=f"Bus {bus_data.bus_id} already exists")

    bus = Bus(
        bus_id=bus_data.bus_id,
        bus_type=bus_data.bus_type,
        v_mag=bus_data.v_mag,
        v_angle=bus_data.v_angle,
        p_gen=bus_data.p_gen,
        q_gen=bus_data.q_gen,
        p_load=bus_data.p_load,
        q_load=bus_data.q_load,
        q_min=bus_data.q_min,
        q_max=bus_data.q_max,
        x=bus_data.x,
        y=bus_data.y,
    )
    engine.add_bus(bus)
    engine.build_ybus()
    engine.reset_solver()
    return await get_system()


@app.put("/api/bus/{bus_id}")
async def update_bus(bus_id: int, update: BusUpdate):
    """Update bus parameters."""
    if bus_id not in engine.buses:
        raise HTTPException(status_code=404, detail=f"Bus {bus_id} not found")

    bus = engine.buses[bus_id]
    for field, value in update.dict(exclude_none=True).items():
        setattr(bus, field, value)

    engine.build_ybus()
    return await get_system()


@app.delete("/api/bus/{bus_id}")
async def delete_bus(bus_id: int):
    """Remove a bus and its connected lines."""
    if bus_id not in engine.buses:
        raise HTTPException(status_code=404, detail=f"Bus {bus_id} not found")
    if engine.buses[bus_id].bus_type == Bus.SLACK and sum(1 for b in engine.buses.values() if b.bus_type == Bus.SLACK) <= 1:
        raise HTTPException(status_code=400, detail="Cannot delete the only slack bus")

    engine.remove_bus(bus_id)
    engine.build_ybus()
    engine.reset_solver()
    return await get_system()


@app.post("/api/line")
async def add_line(line_data: LineCreate):
    """Add a new transmission line."""
    if line_data.line_id in engine.lines:
        raise HTTPException(status_code=400, detail=f"Line {line_data.line_id} already exists")
    if line_data.from_bus not in engine.buses or line_data.to_bus not in engine.buses:
        raise HTTPException(status_code=400, detail="Both buses must exist")

    line = Line(
        line_id=line_data.line_id,
        from_bus=line_data.from_bus,
        to_bus=line_data.to_bus,
        r=line_data.r,
        x=line_data.x,
        b=line_data.b,
        tap=line_data.tap,
        rating=line_data.rating,
    )
    engine.add_line(line)
    engine.build_ybus()
    engine.reset_solver()
    return await get_system()


@app.put("/api/line/{line_id}")
async def update_line(line_id: int, update: LineUpdate):
    """Update line parameters."""
    if line_id not in engine.lines:
        raise HTTPException(status_code=404, detail=f"Line {line_id} not found")

    line = engine.lines[line_id]
    for field, value in update.dict(exclude_none=True).items():
        setattr(line, field, value)

    engine.build_ybus()
    return await get_system()


@app.delete("/api/line/{line_id}")
async def delete_line(line_id: int):
    """Remove a transmission line."""
    if line_id not in engine.lines:
        raise HTTPException(status_code=404, detail=f"Line {line_id} not found")

    engine.remove_line(line_id)
    engine.build_ybus()
    engine.reset_solver()
    return await get_system()


@app.post("/api/line/{line_id}/toggle")
async def toggle_line(line_id: int):
    """Toggle a line on/off (simulate outage)."""
    if line_id not in engine.lines:
        raise HTTPException(status_code=404, detail=f"Line {line_id} not found")

    engine.toggle_line(line_id)
    engine.build_ybus()
    engine.reset_solver()
    return await get_system()


# ===== Solver Endpoints =====

@app.post("/api/solver/reset")
async def reset_solver():
    """Reset solver to flat start."""
    engine.reset_solver()
    engine.build_ybus()
    return await get_system()


@app.post("/api/solver/step")
async def solver_step():
    """Perform one Newton-Raphson iteration."""
    if engine.y_bus is None:
        engine.build_ybus()
    result = engine.step_newton_raphson()
    system = await get_system()
    system['step_result'] = result
    return system


@app.post("/api/solver/solve")
async def solver_solve():
    """Run solver to convergence."""
    engine.reset_solver()
    engine.build_ybus()
    result = engine.solve_full()
    system = await get_system()
    system['solve_result'] = result
    return system


@app.post("/api/solver/settings")
async def update_solver_settings(settings: SolverSettings):
    """Update solver tolerance and max iterations."""
    if settings.tolerance is not None:
        engine.tolerance = settings.tolerance
    if settings.max_iterations is not None:
        engine.max_iterations = settings.max_iterations
    return {'tolerance': engine.tolerance, 'max_iterations': engine.max_iterations}


# ===== Analysis Endpoints =====

@app.post("/api/analysis/pv-curve")
async def compute_pv_curve(req: PVCurveRequest):
    """Compute P-V nose curve for a specific bus."""
    result = engine.compute_pv_curve(req.bus_id, req.steps, req.max_loading)
    return result


@app.post("/api/analysis/scale-load")
async def scale_load(scaling: LoadScaling):
    """Scale all loads by a factor and re-solve."""
    # Store base loads if not stored
    for bus in engine.buses.values():
        if not hasattr(bus, '_base_p_load'):
            bus._base_p_load = bus.p_load
            bus._base_q_load = bus.q_load

    for bus in engine.buses.values():
        bus.p_load = bus._base_p_load * scaling.factor
        bus.q_load = bus._base_q_load * scaling.factor

    engine.reset_solver()
    engine.build_ybus()
    result = engine.solve_full()
    system = await get_system()
    system['solve_result'] = result
    system['load_factor'] = scaling.factor
    return system


@app.get("/api/ybus")
async def get_ybus():
    """Get the Y-Bus admittance matrix."""
    engine.build_ybus()
    return engine.get_ybus_data()


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
