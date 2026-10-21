"""
Power Flow Solver Engine
========================
Core numerical engine for N-Bus power flow analysis.
Implements:
  - Y-Bus admittance matrix construction
  - Newton-Raphson power flow solver (full & step-by-step)
  - Fast Decoupled power flow solver
  - Jacobian matrix computation
  - P-V (nose) curve continuation analysis
  - Line flow & loss calculations
"""

import numpy as np
from typing import List, Dict, Tuple, Optional


class Bus:
    """Represents a bus in the power system."""

    SLACK = 0
    PV = 1
    PQ = 2

    def __init__(self, bus_id: int, bus_type: int = PQ,
                 v_mag: float = 1.0, v_angle: float = 0.0,
                 p_gen: float = 0.0, q_gen: float = 0.0,
                 p_load: float = 0.0, q_load: float = 0.0,
                 q_min: float = -999.0, q_max: float = 999.0,
                 x: float = 0.0, y: float = 0.0):
        self.bus_id = bus_id
        self.bus_type = bus_type
        self.v_mag = v_mag
        self.v_angle = v_angle  # radians
        self.p_gen = p_gen
        self.q_gen = q_gen
        self.p_load = p_load
        self.q_load = q_load
        self.q_min = q_min
        self.q_max = q_max
        self.x = x  # Canvas x position
        self.y = y  # Canvas y position

    @property
    def p_net(self) -> float:
        return self.p_gen - self.p_load

    @property
    def q_net(self) -> float:
        return self.q_gen - self.q_load

    def to_dict(self) -> dict:
        return {
            'bus_id': self.bus_id,
            'bus_type': self.bus_type,
            'v_mag': self.v_mag,
            'v_angle': self.v_angle,
            'v_angle_deg': np.degrees(self.v_angle),
            'p_gen': self.p_gen,
            'q_gen': self.q_gen,
            'p_load': self.p_load,
            'q_load': self.q_load,
            'p_net': self.p_net,
            'q_net': self.q_net,
            'q_min': self.q_min,
            'q_max': self.q_max,
            'x': self.x,
            'y': self.y,
        }


class Line:
    """Represents a transmission line between two buses."""

    def __init__(self, line_id: int, from_bus: int, to_bus: int,
                 r: float = 0.01, x: float = 0.1,
                 b: float = 0.0, tap: float = 1.0,
                 rating: float = 2.0, is_active: bool = True):
        self.line_id = line_id
        self.from_bus = from_bus
        self.to_bus = to_bus
        self.r = r
        self.x = x
        self.b = b  # Total line charging (B/2 at each end)
        self.tap = tap
        self.rating = rating  # MVA rating (per unit)
        self.is_active = is_active

    @property
    def z(self) -> complex:
        return complex(self.r, self.x)

    @property
    def y_series(self) -> complex:
        if abs(self.z) < 1e-12:
            return complex(0, 0)
        return 1.0 / self.z

    @property
    def y_shunt(self) -> complex:
        return complex(0, self.b)

    def to_dict(self) -> dict:
        return {
            'line_id': self.line_id,
            'from_bus': self.from_bus,
            'to_bus': self.to_bus,
            'r': self.r,
            'x': self.x,
            'b': self.b,
            'tap': self.tap,
            'rating': self.rating,
            'is_active': self.is_active,
        }


class PowerFlowEngine:
    """
    N-Bus Power Flow Solver with step-by-step Newton-Raphson iteration
    and P-V continuation analysis.
    """

    def __init__(self):
        self.buses: Dict[int, Bus] = {}
        self.lines: Dict[int, Line] = {}
        self.y_bus: Optional[np.ndarray] = None
        self.n_buses: int = 0
        self.bus_index_map: Dict[int, int] = {}
        self.index_bus_map: Dict[int, int] = {}
        self.converged: bool = False
        self.iteration: int = 0
        self.max_iterations: int = 50
        self.tolerance: float = 1e-6
        self.mismatch_history: List[float] = []
        self.jacobian: Optional[np.ndarray] = None
        self.jacobian_sub: Optional[dict] = None
        self.delta_p: Optional[np.ndarray] = None
        self.delta_q: Optional[np.ndarray] = None

    def add_bus(self, bus: Bus):
        self.buses[bus.bus_id] = bus
        self._rebuild_index_map()

    def remove_bus(self, bus_id: int):
        if bus_id in self.buses:
            del self.buses[bus_id]
            # Remove associated lines
            lines_to_remove = [lid for lid, l in self.lines.items()
                               if l.from_bus == bus_id or l.to_bus == bus_id]
            for lid in lines_to_remove:
                del self.lines[lid]
            self._rebuild_index_map()

    def add_line(self, line: Line):
        self.lines[line.line_id] = line

    def remove_line(self, line_id: int):
        if line_id in self.lines:
            del self.lines[line_id]

    def toggle_line(self, line_id: int):
        if line_id in self.lines:
            self.lines[line_id].is_active = not self.lines[line_id].is_active

    def _rebuild_index_map(self):
        sorted_ids = sorted(self.buses.keys())
        self.bus_index_map = {bid: i for i, bid in enumerate(sorted_ids)}
        self.index_bus_map = {i: bid for i, bid in enumerate(sorted_ids)}
        self.n_buses = len(sorted_ids)

    def build_ybus(self) -> np.ndarray:
        """Build the N×N complex Y-Bus admittance matrix."""
        n = self.n_buses
        if n == 0:
            self.y_bus = np.zeros((0, 0), dtype=complex)
            return self.y_bus

        Y = np.zeros((n, n), dtype=complex)

        for line in self.lines.values():
            if not line.is_active:
                continue
            if line.from_bus not in self.bus_index_map or line.to_bus not in self.bus_index_map:
                continue

            i = self.bus_index_map[line.from_bus]
            j = self.bus_index_map[line.to_bus]

            y_s = line.y_series
            y_sh = line.y_shunt / 2.0  # B/2 at each end
            t = line.tap

            # Pi model with tap ratio
            Y[i, i] += y_s / (t * t) + y_sh
            Y[j, j] += y_s + y_sh
            Y[i, j] -= y_s / t
            Y[j, i] -= y_s / t

        self.y_bus = Y
        return Y

    def get_ybus_data(self) -> dict:
        """Return Y-Bus matrix data for visualization."""
        if self.y_bus is None:
            self.build_ybus()

        n = self.n_buses
        labels = [str(self.index_bus_map[i]) for i in range(n)]
        matrix_real = []
        matrix_imag = []
        matrix_mag = []

        for i in range(n):
            row_real = []
            row_imag = []
            row_mag = []
            for j in range(n):
                val = self.y_bus[i, j]
                row_real.append(round(val.real, 6))
                row_imag.append(round(val.imag, 6))
                row_mag.append(round(abs(val), 6))
            matrix_real.append(row_real)
            matrix_imag.append(row_imag)
            matrix_mag.append(row_mag)

        return {
            'labels': labels,
            'real': matrix_real,
            'imag': matrix_imag,
            'mag': matrix_mag,
            'size': n,
        }

    def _compute_power_injections(self) -> Tuple[np.ndarray, np.ndarray]:
        """Compute calculated P and Q injections from current V, θ."""
        n = self.n_buses
        P_calc = np.zeros(n)
        Q_calc = np.zeros(n)

        V = np.array([self.buses[self.index_bus_map[i]].v_mag for i in range(n)])
        theta = np.array([self.buses[self.index_bus_map[i]].v_angle for i in range(n)])

        for i in range(n):
            for j in range(n):
                g_ij = self.y_bus[i, j].real
                b_ij = self.y_bus[i, j].imag
                angle_diff = theta[i] - theta[j]
                P_calc[i] += V[i] * V[j] * (g_ij * np.cos(angle_diff) + b_ij * np.sin(angle_diff))
                Q_calc[i] += V[i] * V[j] * (g_ij * np.sin(angle_diff) - b_ij * np.cos(angle_diff))

        return P_calc, Q_calc

    def _compute_jacobian(self) -> np.ndarray:
        """Compute the full Jacobian matrix [J1 J2; J3 J4]."""
        n = self.n_buses
        V = np.array([self.buses[self.index_bus_map[i]].v_mag for i in range(n)])
        theta = np.array([self.buses[self.index_bus_map[i]].v_angle for i in range(n)])

        # Determine PQ and PV bus indices
        pq_indices = []
        pv_pq_indices = []

        for i in range(n):
            bus = self.buses[self.index_bus_map[i]]
            if bus.bus_type != Bus.SLACK:
                pv_pq_indices.append(i)
            if bus.bus_type == Bus.PQ:
                pq_indices.append(i)

        n_pv_pq = len(pv_pq_indices)
        n_pq = len(pq_indices)
        j_size = n_pv_pq + n_pq

        J = np.zeros((j_size, j_size))

        # J1: dP/dθ (for non-slack buses)
        # J2: dP/d|V| (for PQ buses)
        # J3: dQ/dθ (for PQ buses, rows)
        # J4: dQ/d|V| (for PQ buses)

        # Sub-matrices
        J1 = np.zeros((n_pv_pq, n_pv_pq))
        J2 = np.zeros((n_pv_pq, n_pq))
        J3 = np.zeros((n_pq, n_pv_pq))
        J4 = np.zeros((n_pq, n_pq))

        for ii, i in enumerate(pv_pq_indices):
            for jj, j in enumerate(pv_pq_indices):
                g_ij = self.y_bus[i, j].real
                b_ij = self.y_bus[i, j].imag
                angle_diff = theta[i] - theta[j]

                if i == j:
                    # Diagonal: dPi/dθi = -Qi_calc - Bii * Vi^2
                    # Compute Qi_calc
                    qi = 0
                    for k in range(n):
                        g_ik = self.y_bus[i, k].real
                        b_ik = self.y_bus[i, k].imag
                        qi += V[i] * V[k] * (g_ik * np.sin(theta[i] - theta[k]) - b_ik * np.cos(theta[i] - theta[k]))
                    J1[ii, jj] = -qi - self.y_bus[i, i].imag * V[i] * V[i]
                else:
                    J1[ii, jj] = V[i] * V[j] * (g_ij * np.sin(angle_diff) - b_ij * np.cos(angle_diff))

        for ii, i in enumerate(pv_pq_indices):
            for jj, j in enumerate(pq_indices):
                g_ij = self.y_bus[i, j].real
                b_ij = self.y_bus[i, j].imag
                angle_diff = theta[i] - theta[j]

                if i == j:
                    pi = 0
                    for k in range(n):
                        g_ik = self.y_bus[i, k].real
                        b_ik = self.y_bus[i, k].imag
                        pi += V[i] * V[k] * (g_ik * np.cos(theta[i] - theta[k]) + b_ik * np.sin(theta[i] - theta[k]))
                    J2[ii, jj] = pi / V[i] + self.y_bus[i, i].real * V[i]
                else:
                    J2[ii, jj] = V[i] * (g_ij * np.cos(angle_diff) + b_ij * np.sin(angle_diff))

        for ii, i in enumerate(pq_indices):
            for jj, j in enumerate(pv_pq_indices):
                g_ij = self.y_bus[i, j].real
                b_ij = self.y_bus[i, j].imag
                angle_diff = theta[i] - theta[j]

                if i == j:
                    pi = 0
                    for k in range(n):
                        g_ik = self.y_bus[i, k].real
                        b_ik = self.y_bus[i, k].imag
                        pi += V[i] * V[k] * (g_ik * np.cos(theta[i] - theta[k]) + b_ik * np.sin(theta[i] - theta[k]))
                    J3[ii, jj] = pi - self.y_bus[i, i].real * V[i] * V[i]
                else:
                    J3[ii, jj] = -V[i] * V[j] * (g_ij * np.cos(angle_diff) + b_ij * np.sin(angle_diff))

        for ii, i in enumerate(pq_indices):
            for jj, j in enumerate(pq_indices):
                g_ij = self.y_bus[i, j].real
                b_ij = self.y_bus[i, j].imag
                angle_diff = theta[i] - theta[j]

                if i == j:
                    qi = 0
                    for k in range(n):
                        g_ik = self.y_bus[i, k].real
                        b_ik = self.y_bus[i, k].imag
                        qi += V[i] * V[k] * (g_ik * np.sin(theta[i] - theta[k]) - b_ik * np.cos(theta[i] - theta[k]))
                    J4[ii, jj] = qi / V[i] - self.y_bus[i, i].imag * V[i]
                else:
                    J4[ii, jj] = V[i] * (g_ij * np.sin(angle_diff) - b_ij * np.cos(angle_diff))

        # Assemble full Jacobian
        J[:n_pv_pq, :n_pv_pq] = J1
        J[:n_pv_pq, n_pv_pq:] = J2
        J[n_pv_pq:, :n_pv_pq] = J3
        J[n_pv_pq:, n_pv_pq:] = J4

        self.jacobian = J
        self.jacobian_sub = {
            'J1': J1.tolist(),
            'J2': J2.tolist(),
            'J3': J3.tolist(),
            'J4': J4.tolist(),
            'pv_pq_buses': [self.index_bus_map[i] for i in pv_pq_indices],
            'pq_buses': [self.index_bus_map[i] for i in pq_indices],
        }

        return J

    def reset_solver(self):
        """Reset solver state for fresh iteration."""
        self.converged = False
        self.iteration = 0
        self.mismatch_history = []
        self.jacobian = None
        self.jacobian_sub = None
        self.delta_p = None
        self.delta_q = None

        # Reset bus voltages to flat start (except slack)
        for bus in self.buses.values():
            if bus.bus_type != Bus.SLACK:
                if bus.bus_type == Bus.PQ:
                    bus.v_mag = 1.0
                bus.v_angle = 0.0

    def step_newton_raphson(self) -> dict:
        """Perform one Newton-Raphson iteration and return detailed results."""
        if self.y_bus is None:
            self.build_ybus()

        n = self.n_buses
        if n < 2:
            return {'error': 'Need at least 2 buses', 'converged': False}

        # Get bus ordering
        pq_indices = []
        pv_pq_indices = []

        for i in range(n):
            bus = self.buses[self.index_bus_map[i]]
            if bus.bus_type != Bus.SLACK:
                pv_pq_indices.append(i)
            if bus.bus_type == Bus.PQ:
                pq_indices.append(i)

        # Compute power injections
        P_calc, Q_calc = self._compute_power_injections()

        # Compute mismatches
        delta_P = np.zeros(len(pv_pq_indices))
        delta_Q = np.zeros(len(pq_indices))

        for ii, i in enumerate(pv_pq_indices):
            bus = self.buses[self.index_bus_map[i]]
            delta_P[ii] = bus.p_net - P_calc[i]

        for ii, i in enumerate(pq_indices):
            bus = self.buses[self.index_bus_map[i]]
            delta_Q[ii] = bus.q_net - Q_calc[i]

        self.delta_p = delta_P
        self.delta_q = delta_Q

        # Check convergence
        mismatch = np.concatenate([delta_P, delta_Q])
        max_mismatch = np.max(np.abs(mismatch)) if len(mismatch) > 0 else 0.0
        self.mismatch_history.append(float(max_mismatch))

        if max_mismatch < self.tolerance:
            self.converged = True
            # Compute Q for PV buses
            for i in range(n):
                bus = self.buses[self.index_bus_map[i]]
                if bus.bus_type == Bus.PV:
                    bus.q_gen = Q_calc[i] + bus.q_load
                elif bus.bus_type == Bus.SLACK:
                    bus.p_gen = P_calc[i] + bus.p_load
                    bus.q_gen = Q_calc[i] + bus.q_load

            return self._build_step_result(max_mismatch)

        # Compute Jacobian
        J = self._compute_jacobian()

        # Solve J * Δx = mismatch
        try:
            dx = np.linalg.solve(J, mismatch)
        except np.linalg.LinAlgError:
            return {'error': 'Jacobian is singular - system may be unsolvable',
                    'converged': False, 'iteration': self.iteration}

        # Update voltage angles
        for ii, i in enumerate(pv_pq_indices):
            bus = self.buses[self.index_bus_map[i]]
            bus.v_angle += dx[ii]

        # Update voltage magnitudes for PQ buses
        n_pv_pq = len(pv_pq_indices)
        for ii, i in enumerate(pq_indices):
            bus = self.buses[self.index_bus_map[i]]
            bus.v_mag += dx[n_pv_pq + ii]

        self.iteration += 1

        # Recompute Q for PV and Slack buses
        P_calc_new, Q_calc_new = self._compute_power_injections()
        for i in range(n):
            bus = self.buses[self.index_bus_map[i]]
            if bus.bus_type == Bus.PV:
                bus.q_gen = Q_calc_new[i] + bus.q_load
            elif bus.bus_type == Bus.SLACK:
                bus.p_gen = P_calc_new[i] + bus.p_load
                bus.q_gen = Q_calc_new[i] + bus.q_load

        return self._build_step_result(max_mismatch)

    def solve_full(self) -> dict:
        """Run Newton-Raphson to convergence."""
        self.reset_solver()
        self.build_ybus()

        results = []
        for _ in range(self.max_iterations):
            result = self.step_newton_raphson()
            results.append(result)
            if self.converged or 'error' in result:
                break

        # Compute final Jacobian at converged solution for display
        if self.converged and self.n_buses >= 2:
            try:
                self._compute_jacobian()
            except Exception:
                pass

        return {
            'converged': self.converged,
            'iterations': self.iteration,
            'final_result': results[-1] if results else None,
            'mismatch_history': self.mismatch_history,
        }

    def _build_step_result(self, max_mismatch: float) -> dict:
        """Build comprehensive result dict for a single NR step."""
        line_flows = self.compute_line_flows()

        return {
            'iteration': self.iteration,
            'converged': self.converged,
            'max_mismatch': float(max_mismatch),
            'mismatch_history': [float(m) for m in self.mismatch_history],
            'buses': {bid: bus.to_dict() for bid, bus in self.buses.items()},
            'lines': line_flows,
            'jacobian': self.jacobian_sub,
            'delta_p': self.delta_p.tolist() if self.delta_p is not None else [],
            'delta_q': self.delta_q.tolist() if self.delta_q is not None else [],
        }

    def compute_line_flows(self) -> list:
        """Compute active/reactive power flows and losses on each line."""
        flows = []
        for line in self.lines.values():
            if not line.is_active:
                flows.append({
                    **line.to_dict(),
                    'p_from': 0, 'q_from': 0, 'p_to': 0, 'q_to': 0,
                    'p_loss': 0, 'q_loss': 0, 'loading_pct': 0,
                    'i_mag': 0,
                })
                continue

            if line.from_bus not in self.bus_index_map or line.to_bus not in self.bus_index_map:
                continue

            i = self.bus_index_map[line.from_bus]
            j = self.bus_index_map[line.to_bus]

            bus_i = self.buses[line.from_bus]
            bus_j = self.buses[line.to_bus]

            Vi = bus_i.v_mag * np.exp(1j * bus_i.v_angle)
            Vj = bus_j.v_mag * np.exp(1j * bus_j.v_angle)

            y_s = line.y_series
            y_sh = complex(0, line.b / 2.0)
            t = line.tap

            # Current from i to j
            I_ij = (Vi / t - Vj) * y_s + Vi * y_sh / (t * t)
            # Current from j to i
            I_ji = (Vj - Vi / t) * y_s + Vj * y_sh

            # Complex power
            S_ij = Vi * np.conj(I_ij) / t
            S_ji = Vj * np.conj(I_ji)

            # Current magnitude for loading
            i_mag = abs(I_ij)
            # Approximate loading as S/Rating
            s_mag = abs(S_ij)
            loading_pct = (s_mag / line.rating * 100) if line.rating > 0 else 0

            flows.append({
                **line.to_dict(),
                'p_from': round(float(S_ij.real), 6),
                'q_from': round(float(S_ij.imag), 6),
                'p_to': round(float(S_ji.real), 6),
                'q_to': round(float(S_ji.imag), 6),
                'p_loss': round(float(S_ij.real + S_ji.real), 6),
                'q_loss': round(float(S_ij.imag + S_ji.imag), 6),
                'loading_pct': round(float(min(loading_pct, 999)), 2),
                'i_mag': round(float(i_mag), 6),
            })

        return flows

    def compute_pv_curve(self, target_bus_id: int, steps: int = 60,
                         max_loading: float = 3.0) -> dict:
        """
        Compute P-V (nose) curve for a specific load bus.
        Scales all loads from 0% to max_loading*100%.
        Returns voltage magnitude at target bus vs total load power.
        """
        if target_bus_id not in self.buses:
            return {'error': f'Bus {target_bus_id} not found'}

        # Save original state
        original_state = {}
        for bid, bus in self.buses.items():
            original_state[bid] = {
                'v_mag': bus.v_mag, 'v_angle': bus.v_angle,
                'p_load': bus.p_load, 'q_load': bus.q_load,
                'p_gen': bus.p_gen, 'q_gen': bus.q_gen,
            }

        base_loads = {bid: (bus.p_load, bus.q_load)
                      for bid, bus in self.buses.items()}

        p_values = []
        v_values = []
        collapse_loading = None

        for step in range(steps + 1):
            loading = (step / steps) * max_loading

            # Scale all loads
            for bid, bus in self.buses.items():
                bus.p_load = base_loads[bid][0] * loading
                bus.q_load = base_loads[bid][1] * loading

            # Reset and solve
            self.reset_solver()
            self.build_ybus()
            result = self.solve_full()

            target_bus = self.buses[target_bus_id]
            total_p_load = sum(bus.p_load for bus in self.buses.values())

            if result['converged']:
                p_values.append(round(float(total_p_load), 4))
                v_values.append(round(float(target_bus.v_mag), 4))
            else:
                if collapse_loading is None:
                    collapse_loading = loading
                # Still add the last converged point
                break

        # Restore original state
        for bid, bus in self.buses.items():
            state = original_state[bid]
            bus.v_mag = state['v_mag']
            bus.v_angle = state['v_angle']
            bus.p_load = state['p_load']
            bus.q_load = state['q_load']
            bus.p_gen = state['p_gen']
            bus.q_gen = state['q_gen']

        return {
            'bus_id': target_bus_id,
            'p_values': p_values,
            'v_values': v_values,
            'collapse_loading': collapse_loading,
            'nose_point': {
                'p': p_values[-1] if p_values else 0,
                'v': v_values[-1] if v_values else 0,
            } if collapse_loading else None,
        }

    def get_system_summary(self) -> dict:
        """Get overall system analytics."""
        total_p_gen = sum(b.p_gen for b in self.buses.values())
        total_q_gen = sum(b.q_gen for b in self.buses.values())
        total_p_load = sum(b.p_load for b in self.buses.values())
        total_q_load = sum(b.q_load for b in self.buses.values())

        line_flows = self.compute_line_flows()
        total_p_loss = sum(lf['p_loss'] for lf in line_flows)
        total_q_loss = sum(lf['q_loss'] for lf in line_flows)

        min_v_bus = None
        min_v = float('inf')
        for bus in self.buses.values():
            if bus.bus_type != Bus.SLACK and bus.v_mag < min_v:
                min_v = bus.v_mag
                min_v_bus = bus.bus_id

        max_loading_line = None
        max_loading = 0
        for lf in line_flows:
            if lf['loading_pct'] > max_loading:
                max_loading = lf['loading_pct']
                max_loading_line = lf['line_id']

        return {
            'total_p_gen': round(total_p_gen, 4),
            'total_q_gen': round(total_q_gen, 4),
            'total_p_load': round(total_p_load, 4),
            'total_q_load': round(total_q_load, 4),
            'total_p_loss': round(total_p_loss, 4),
            'total_q_loss': round(total_q_loss, 4),
            'min_voltage_bus': min_v_bus,
            'min_voltage': round(min_v, 4) if min_v < float('inf') else None,
            'max_loading_line': max_loading_line,
            'max_loading_pct': round(max_loading, 2),
            'converged': self.converged,
            'iterations': self.iteration,
        }


# ===== Preset Topologies =====

def create_2bus_system() -> PowerFlowEngine:
    """2-Bus Infinite Bus system."""
    engine = PowerFlowEngine()
    engine.add_bus(Bus(1, Bus.SLACK, v_mag=1.05, v_angle=0.0, x=250, y=220))
    engine.add_bus(Bus(2, Bus.PQ, v_mag=1.0, v_angle=0.0,
                       p_load=0.5, q_load=0.3, x=600, y=220))
    engine.add_line(Line(1, 1, 2, r=0.02, x=0.06, b=0.03, rating=2.0))
    return engine


def create_3bus_system() -> PowerFlowEngine:
    """3-Bus Triangle system."""
    engine = PowerFlowEngine()
    engine.add_bus(Bus(1, Bus.SLACK, v_mag=1.05, v_angle=0.0, x=400, y=80))
    engine.add_bus(Bus(2, Bus.PV, v_mag=1.04, v_angle=0.0,
                       p_gen=0.5, x=180, y=340))
    engine.add_bus(Bus(3, Bus.PQ, v_mag=1.0, v_angle=0.0,
                       p_load=0.6, q_load=0.25, x=620, y=340))

    engine.add_line(Line(1, 1, 2, r=0.02, x=0.06, b=0.03, rating=2.0))
    engine.add_line(Line(2, 1, 3, r=0.08, x=0.24, b=0.025, rating=1.5))
    engine.add_line(Line(3, 2, 3, r=0.06, x=0.18, b=0.02, rating=1.5))
    return engine


def create_5bus_system() -> PowerFlowEngine:
    """5-Bus IEEE Test System."""
    engine = PowerFlowEngine()

    engine.add_bus(Bus(1, Bus.SLACK, v_mag=1.06, v_angle=0.0, x=420, y=60))
    engine.add_bus(Bus(2, Bus.PV, v_mag=1.045, v_angle=0.0,
                       p_gen=0.4, x=150, y=200))
    engine.add_bus(Bus(3, Bus.PQ, v_mag=1.0, v_angle=0.0,
                       p_load=0.45, q_load=0.15, x=690, y=200))
    engine.add_bus(Bus(4, Bus.PQ, v_mag=1.0, v_angle=0.0,
                       p_load=0.4, q_load=0.05, x=250, y=370))
    engine.add_bus(Bus(5, Bus.PQ, v_mag=1.0, v_angle=0.0,
                       p_load=0.6, q_load=0.1, x=580, y=370))

    engine.add_line(Line(1, 1, 2, r=0.02, x=0.06, b=0.03, rating=2.0))
    engine.add_line(Line(2, 1, 3, r=0.08, x=0.24, b=0.025, rating=1.5))
    engine.add_line(Line(3, 2, 3, r=0.06, x=0.18, b=0.02, rating=1.5))
    engine.add_line(Line(4, 2, 4, r=0.06, x=0.18, b=0.02, rating=1.5))
    engine.add_line(Line(5, 2, 5, r=0.04, x=0.12, b=0.015, rating=1.8))
    engine.add_line(Line(6, 3, 4, r=0.01, x=0.03, b=0.01, rating=2.5))
    engine.add_line(Line(7, 4, 5, r=0.08, x=0.24, b=0.025, rating=1.5))

    return engine


PRESETS = {
    '2bus': create_2bus_system,
    '3bus': create_3bus_system,
    '5bus': create_5bus_system,
}
