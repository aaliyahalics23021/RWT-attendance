// App State
const ADMIN_SECRET_KEY = "admin";
const FACE_MODEL_URL = "https://cdn.jsdelivr.net/gh/justadudewhohacks/face-api.js@master/weights";
const FACE_MATCH_THRESHOLD = 0.55;

let config = JSON.parse(localStorage.getItem('office_config') || JSON.stringify({
    lat: 21.1654,
    lng: 79.0808,
    radius: 100 // meters
}));

let employees = JSON.parse(localStorage.getItem('office_employees') || '[]');
let attendanceLogs = JSON.parse(localStorage.getItem('office_attendance') || '[]');
let leaveRequests = JSON.parse(localStorage.getItem('office_leaves') || '[]');

let checkinStream = null;
let currentCandidate = null;
let currentDistanceMeters = null;
let capturedSelfieBase64 = null;
let deptChartInstance = null;
let faceModelsPromise = null;
let registrationStream = null;
let employeeLoginStream = null;
let pendingRegistrationDescriptor = null;
let currentEmployeeSession = null;
let isAdminAuthenticated = false;

window.addEventListener('DOMContentLoaded', () => {
    document.getElementById('geo-lat').value = config.lat;
    document.getElementById('geo-lng').value = config.lng;
    document.getElementById('geo-radius').value = config.radius;
    renderAdminViews();
    document.getElementById('employee-month-label').innerText =
        new Date().toLocaleDateString([], { month: 'long', year: 'numeric' });
});

// Tab Switching
function switchTab(tab) {
    if (tab === 'admin' && !isAdminAuthenticated) return;
    if (tab === 'employee-dashboard' && !currentEmployeeSession) return;

    ['checkin', 'leave', 'register', 'employee-login', 'employee-dashboard', 'admin'].forEach(t => {
        const sec = document.getElementById(`sec-${t}`);
        const btn = document.getElementById(`tab-${t}`);
        if (sec) sec.classList.add('hidden');
        if (btn) btn.className = `py-3 text-sm tab-inactive${btn.classList.contains('hidden') ? ' hidden' : ''}`;
    });

    document.getElementById(`sec-${tab}`).classList.remove('hidden');
    document.getElementById(`tab-${tab}`).className = 'py-3 text-sm tab-active';

    if (tab === 'admin') {
        renderAdminViews();
    }
    if (tab === 'employee-dashboard') {
        renderEmployeeDashboard();
    }
}

async function ensureFaceModelsLoaded() {
    if (typeof faceapi === 'undefined') {
        throw new Error('Face verification library did not load. Check your internet connection and reload the page.');
    }
    if (!faceModelsPromise) {
        faceModelsPromise = Promise.all([
            faceapi.nets.tinyFaceDetector.loadFromUri(FACE_MODEL_URL),
            faceapi.nets.faceLandmark68Net.loadFromUri(FACE_MODEL_URL),
            faceapi.nets.faceRecognitionNet.loadFromUri(FACE_MODEL_URL)
        ]);
    }
    try {
        await faceModelsPromise;
    } catch (err) {
        faceModelsPromise = null;
        throw new Error(`Could not load face verification models: ${err.message}`);
    }
}

async function readFaceDescriptor(video) {
    await ensureFaceModelsLoaded();
    const result = await faceapi
        .detectSingleFace(video, new faceapi.TinyFaceDetectorOptions({ inputSize: 320, scoreThreshold: 0.5 }))
        .withFaceLandmarks()
        .withFaceDescriptor();
    if (!result) {
        throw new Error('No clear face detected. Face the camera and try again.');
    }
    return Array.from(result.descriptor);
}

function stopCamera(stream, videoId, placeholderId) {
    if (stream) stream.getTracks().forEach(track => track.stop());
    const video = document.getElementById(videoId);
    if (video) {
        video.srcObject = null;
        video.classList.add('hidden');
    }
    const placeholder = document.getElementById(placeholderId);
    if (placeholder) placeholder.classList.remove('hidden');
}

function setFaceMatchStatus(employee, descriptor) {
    if (!Array.isArray(employee.faceDescriptor) || employee.faceDescriptor.length !== descriptor.length) {
        throw new Error('No face is registered for this employee ID. Complete first-time registration before logging in.');
    }
    const distance = faceapi.euclideanDistance(employee.faceDescriptor, descriptor);
    if (distance > FACE_MATCH_THRESHOLD) {
        throw new Error('Face did not match the registered profile for this ID. Please try again.');
    }
}

// Step 1: Check-In Entry & Admin Key Handling
function verifyStep1() {
    const inputVal = document.getElementById('checkin-id').value.trim();
    const resultBox = document.getElementById('checkin-result');
    resultBox.classList.add('hidden');

    if (!inputVal) {
        alert('Please enter Phone/ID or Admin key.');
        return;
    }

    // Secret Admin Access Check
    if (inputVal.toLowerCase() === ADMIN_SECRET_KEY) {
        isAdminAuthenticated = true;
        document.getElementById('tab-admin').classList.remove('hidden');
        document.getElementById('admin-badge').classList.remove('hidden');
        switchTab('admin');
        document.getElementById('checkin-id').value = '';
        return;
    }

    // Find Employee
    currentCandidate = employees.find(e => e.phone === inputVal);
    const statusBox = document.getElementById('geo-status-box');

    if (!currentCandidate) {
        statusBox.innerHTML = '<span class="text-red-600 font-semibold">Employee ID not registered.</span>';
        return;
    }

    statusBox.innerHTML = '<span class="text-slate-500">Checking Geolocation distance...</span>';

    if (!navigator.geolocation) {
        statusBox.innerHTML = '<span class="text-red-600">Geolocation not supported by browser.</span>';
        return;
    }

    navigator.geolocation.getCurrentPosition(
        (pos) => {
            const userLat = pos.coords.latitude;
            const userLng = pos.coords.longitude;
            currentDistanceMeters = calculateDistanceMeters(userLat, userLng, config.lat, config.lng);

            if (currentDistanceMeters <= config.radius) {
                statusBox.innerHTML = `
                    <div class="text-emerald-700 font-semibold">✓ In Office Geofence</div>
                    <div class="text-[11px] text-slate-500">Distance: ${currentDistanceMeters.toFixed(1)}m from target</div>
                `;
                startCamera();
            } else {
                statusBox.innerHTML = `
                    <div class="text-red-600 font-semibold">✕ Out of Geofence Range</div>
                    <div class="text-[11px] text-slate-500">Distance: ${currentDistanceMeters.toFixed(1)}m (Max Allowed: ${config.radius}m)</div>
                `;
            }
        },
        (err) => {
            statusBox.innerHTML = `<span class="text-red-600">GPS Error: ${err.message}</span>`;
        }
    );
}

// Haversine formula to compute meters between two coordinates
function calculateDistanceMeters(lat1, lon1, lat2, lon2) {
    const R = 6371e3; // Earth radius in meters
    const φ1 = lat1 * Math.PI / 180;
    const φ2 = lat2 * Math.PI / 180;
    const Δφ = (lat2 - lat1) * Math.PI / 180;
    const Δλ = (lon2 - lon1) * Math.PI / 180;

    const a = Math.sin(Δφ/2) * Math.sin(Δφ/2) +
              Math.cos(φ1) * Math.cos(φ2) *
              Math.sin(Δλ/2) * Math.sin(Δλ/2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
    return R * c;
}

// Start Camera for Snapshot
async function startCamera() {
    try {
        checkinStream = await navigator.mediaDevices.getUserMedia({ video: true });
        const video = document.getElementById('checkin-video');
        video.srcObject = checkinStream;
        video.classList.remove('hidden');
        document.getElementById('checkin-cam-placeholder').classList.add('hidden');

        const btn = document.getElementById('btn-submit-attendance');
        btn.disabled = false;
        btn.className = 'w-full btn-primary text-xs py-2 rounded font-medium cursor-pointer';
    } catch (err) {
        alert('Camera error: ' + err.message);
    }
}

// Record Attendance & Capture Selfie Canvas
async function performCheckIn() {
    const video = document.getElementById('checkin-video');
    const resultBox = document.getElementById('checkin-result');
    const submitButton = document.getElementById('btn-submit-attendance');
    submitButton.disabled = true;
    submitButton.innerText = 'Verifying face...';
    try {
        const descriptor = await readFaceDescriptor(video);
        setFaceMatchStatus(currentCandidate, descriptor);
    } catch (err) {
        resultBox.innerText = err.message;
        resultBox.className = 'mt-6 p-4 border rounded text-xs font-medium bg-red-50 text-red-800 border-red-200 block';
        submitButton.disabled = false;
        submitButton.innerText = 'Verify Face & Record';
        return;
    }

    const canvas = document.createElement('canvas');
    canvas.width = 320;
    canvas.height = 240;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    capturedSelfieBase64 = canvas.toDataURL('image/jpeg', 0.7);

    const now = new Date();
    const timeString = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    const log = {
        date: getLocalDateKey(now),
        time: timeString,
        name: currentCandidate.name,
        phone: currentCandidate.phone,
        dept: currentCandidate.dept,
        distance: `${currentDistanceMeters.toFixed(1)}m`,
        selfie: capturedSelfieBase64
    };

    attendanceLogs.unshift(log);
    localStorage.setItem('office_attendance', JSON.stringify(attendanceLogs));

    resultBox.innerHTML = `✓ Attendance Recorded for <strong>${currentCandidate.name}</strong> at ${timeString}`;
    resultBox.className = 'mt-6 p-4 border rounded text-xs font-medium bg-emerald-50 text-emerald-900 border-emerald-200 block';

    if (checkinStream) {
        stopCamera(checkinStream, 'checkin-video', 'checkin-cam-placeholder');
        checkinStream = null;
    }

    submitButton.disabled = true;
    submitButton.innerText = 'Verify Face & Record';
    submitButton.className = 'w-full bg-slate-300 text-slate-500 text-xs py-2 rounded font-medium cursor-not-allowed';
    if (currentEmployeeSession && currentEmployeeSession.phone === currentCandidate.phone) {
        renderEmployeeDashboard();
    }
}

// Apply Leave (Employee Side)
function handleApplyLeave(e) {
    e.preventDefault();
    const empId = currentEmployeeSession
        ? currentEmployeeSession.phone
        : document.getElementById('leave-emp-id').value.trim();
    const type = document.getElementById('leave-type').value;
    const start = document.getElementById('leave-start').value;
    const end = document.getElementById('leave-end').value;
    const reason = document.getElementById('leave-reason').value.trim();

    const leave = {
        id: 'LV_' + Date.now(),
        empId,
        type,
        start,
        end,
        reason,
        status: 'Pending'
    };

    leaveRequests.unshift(leave);
    localStorage.setItem('office_leaves', JSON.stringify(leaveRequests));

    const res = document.getElementById('leave-result');
    res.innerText = 'Leave request submitted successfully. Awaiting admin approval.';
    res.className = 'mt-4 p-3 border rounded text-xs font-medium bg-emerald-50 text-emerald-800 border-emerald-200 block';
    e.target.reset();
}

// Register Employee
async function startRegistrationCamera() {
    const status = document.getElementById('register-face-status');
    try {
        await ensureFaceModelsLoaded();
        registrationStream = await navigator.mediaDevices.getUserMedia({ video: true });
        const video = document.getElementById('register-video');
        video.srcObject = registrationStream;
        video.classList.remove('hidden');
        document.getElementById('register-cam-placeholder').classList.add('hidden');
        document.getElementById('btn-capture-registration-face').disabled = false;
        document.getElementById('btn-capture-registration-face').className =
            'flex-1 btn-primary text-xs py-2 rounded font-medium cursor-pointer';
        status.innerText = 'Camera ready. Capture a clear image of your face.';
        status.className = 'text-xs text-slate-500 mt-2';
    } catch (err) {
        status.innerText = `Unable to start face enrollment: ${err.message}`;
        status.className = 'text-xs text-red-700 mt-2';
    }
}

async function captureRegistrationFace() {
    const status = document.getElementById('register-face-status');
    try {
        pendingRegistrationDescriptor = await readFaceDescriptor(document.getElementById('register-video'));
        status.innerText = 'Face captured. Your face template will be saved in this browser when you save the profile.';
        status.className = 'text-xs text-emerald-700 mt-2';
    } catch (err) {
        pendingRegistrationDescriptor = null;
        status.innerText = err.message;
        status.className = 'text-xs text-red-700 mt-2';
    }
}

function handleRegistration(e) {
    e.preventDefault();
    const name = document.getElementById('reg-name').value.trim();
    const phone = document.getElementById('reg-phone').value.trim();
    const dept = document.getElementById('reg-dept').value;

    if (!pendingRegistrationDescriptor) {
        const status = document.getElementById('register-face-status');
        status.innerText = 'Capture your face before saving the employee profile.';
        status.className = 'text-xs text-red-700 mt-2';
        return;
    }

    const existingEmployee = employees.find(emp => emp.phone === phone);
    if (existingEmployee && Array.isArray(existingEmployee.faceDescriptor)) {
        alert('This employee already has a registered face.');
        return;
    }

    if (existingEmployee) {
        existingEmployee.faceDescriptor = pendingRegistrationDescriptor;
    } else {
        employees.push({ name, phone, dept, faceDescriptor: pendingRegistrationDescriptor });
    }
    localStorage.setItem('office_employees', JSON.stringify(employees));

    const res = document.getElementById('reg-result');
    res.innerText = existingEmployee
        ? `Face enrolled for existing employee ${existingEmployee.name}.`
        : `Successfully registered ${name} (${dept}) with face verification.`;
    res.className = 'mt-4 p-3 border rounded text-xs font-medium bg-emerald-50 text-emerald-800 border-emerald-200 block';
    pendingRegistrationDescriptor = null;
    stopCamera(registrationStream, 'register-video', 'register-cam-placeholder');
    registrationStream = null;
    document.getElementById('btn-capture-registration-face').disabled = true;
    document.getElementById('btn-capture-registration-face').className =
        'flex-1 bg-slate-300 text-slate-500 text-xs py-2 rounded font-medium cursor-not-allowed';
    document.getElementById('register-face-status').innerText = 'Face template saved locally in this browser.';
    document.getElementById('register-face-status').className = 'text-xs text-emerald-700 mt-2';
    e.target.reset();
}

async function startEmployeeLoginCamera() {
    const status = document.getElementById('employee-login-status');
    try {
        await ensureFaceModelsLoaded();
        employeeLoginStream = await navigator.mediaDevices.getUserMedia({ video: true });
        const video = document.getElementById('employee-login-video');
        video.srcObject = employeeLoginStream;
        video.classList.remove('hidden');
        document.getElementById('employee-login-cam-placeholder').classList.add('hidden');
        const button = document.getElementById('btn-employee-login');
        button.disabled = false;
        button.className = 'w-full btn-primary text-xs py-2.5 rounded font-medium cursor-pointer';
        status.innerText = 'Camera ready. Enter your employee ID, then verify your face.';
        status.className = 'text-xs text-slate-500';
    } catch (err) {
        status.innerText = `Unable to start face verification: ${err.message}`;
        status.className = 'text-xs text-red-700';
    }
}

async function handleEmployeeLogin(e) {
    e.preventDefault();
    const employeeId = document.getElementById('employee-login-id').value.trim();
    const status = document.getElementById('employee-login-status');
    const button = document.getElementById('btn-employee-login');
    const employee = employees.find(item => item.phone === employeeId);

    if (!employee) {
        status.innerText = 'No employee is registered with that ID.';
        status.className = 'text-xs text-red-700';
        return;
    }

    button.disabled = true;
    button.innerText = 'Verifying face...';
    try {
        const descriptor = await readFaceDescriptor(document.getElementById('employee-login-video'));
        setFaceMatchStatus(employee, descriptor);
        currentEmployeeSession = employee;
        isAdminAuthenticated = false;
        document.getElementById('tab-admin').classList.add('hidden');
        document.getElementById('admin-badge').classList.add('hidden');
        document.getElementById('tab-employee-dashboard').classList.remove('hidden');
        const leaveEmployeeId = document.getElementById('leave-emp-id');
        leaveEmployeeId.value = employee.phone;
        leaveEmployeeId.readOnly = true;
        document.getElementById('employee-dashboard-title').innerText = `Welcome, ${employee.name}`;
        stopCamera(employeeLoginStream, 'employee-login-video', 'employee-login-cam-placeholder');
        employeeLoginStream = null;
        status.innerText = 'Face verified. Your dashboard is ready.';
        status.className = 'text-xs text-emerald-700';
        switchTab('employee-dashboard');
    } catch (err) {
        status.innerText = err.message;
        status.className = 'text-xs text-red-700';
    } finally {
        button.disabled = !employeeLoginStream;
        button.innerText = 'Verify Face & Login';
        button.className = button.disabled
            ? 'w-full bg-slate-300 text-slate-500 text-xs py-2.5 rounded font-medium cursor-not-allowed'
            : 'w-full btn-primary text-xs py-2.5 rounded font-medium cursor-pointer';
    }
}

function logoutEmployee() {
    currentEmployeeSession = null;
    document.getElementById('tab-employee-dashboard').classList.add('hidden');
    document.getElementById('leave-emp-id').readOnly = false;
    document.getElementById('leave-emp-id').value = '';
    document.getElementById('employee-login-id').value = '';
    document.getElementById('employee-login-status').innerText = '';
    switchTab('employee-login');
}

function getLocalDateKey(date) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}

function getAttendanceDateKey(dateValue) {
    if (/^\d{4}-\d{2}-\d{2}$/.test(dateValue)) return dateValue;
    const numericDate = String(dateValue).match(/^(\d{1,4})[/. -](\d{1,2})[/. -](\d{1,4})$/);
    if (numericDate) {
        const order = new Intl.DateTimeFormat().formatToParts(new Date(2001, 10, 22))
            .filter(part => ['day', 'month', 'year'].includes(part.type))
            .map(part => part.type);
        const components = {};
        order.forEach((part, index) => { components[part] = Number(numericDate[index + 1]); });
        const parsed = new Date(components.year, components.month - 1, components.day);
        if (parsed.getFullYear() === components.year &&
            parsed.getMonth() === components.month - 1 &&
            parsed.getDate() === components.day) {
            return getLocalDateKey(parsed);
        }
        return null;
    }
    const parsed = new Date(dateValue);
    return Number.isNaN(parsed.getTime()) ? null : getLocalDateKey(parsed);
}

function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, character => ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;'
    })[character]);
}

function renderEmployeeDashboard() {
    if (!currentEmployeeSession) return;
    const now = new Date();
    const monthPrefix = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-`;
    const todayKey = getLocalDateKey(now);
    const presentDates = new Set(attendanceLogs
        .filter(log => log.phone === currentEmployeeSession.phone)
        .map(log => getAttendanceDateKey(log.date))
        .filter(dateKey => dateKey && dateKey.startsWith(monthPrefix) && dateKey <= todayKey));
    const employeeLeaves = leaveRequests.filter(request => request.empId === currentEmployeeSession.phone);
    const approved = employeeLeaves.filter(request => request.status === 'Approved').length;
    const rejected = employeeLeaves.filter(request => request.status === 'Rejected').length;

    document.getElementById('employee-present-days').innerText = presentDates.size;
    document.getElementById('employee-approved-leaves').innerText = approved;
    document.getElementById('employee-rejected-leaves').innerText = rejected;

    const body = document.getElementById('employee-leave-table-body');
    if (!employeeLeaves.length) {
        body.innerHTML = '<tr><td colspan="4" class="p-3 text-center text-slate-400">You have no leave requests yet.</td></tr>';
        return;
    }
    body.innerHTML = employeeLeaves.map(request => `
        <tr>
            <td class="p-2">${escapeHtml(request.type)}</td>
            <td class="p-2 text-slate-500">${escapeHtml(request.start)} to ${escapeHtml(request.end)}</td>
            <td class="p-2">${escapeHtml(request.reason)}</td>
            <td class="p-2 font-semibold ${request.status === 'Approved' ? 'text-emerald-700' : request.status === 'Rejected' ? 'text-red-600' : 'text-amber-600'}">${escapeHtml(request.status)}</td>
        </tr>
    `).join('');
}

// Admin - Save Geofence Settings
function saveGeofenceSettings(e) {
    e.preventDefault();
    config.lat = parseFloat(document.getElementById('geo-lat').value);
    config.lng = parseFloat(document.getElementById('geo-lng').value);
    config.radius = parseFloat(document.getElementById('geo-radius').value);

    localStorage.setItem('office_config', JSON.stringify(config));
    const msg = document.getElementById('geo-save-msg');
    msg.classList.remove('hidden');
    setTimeout(() => msg.classList.add('hidden'), 3000);
}

// Admin - Logout
function logoutAdmin() {
    isAdminAuthenticated = false;
    document.getElementById('tab-admin').classList.add('hidden');
    document.getElementById('admin-badge').classList.add('hidden');
    switchTab('checkin');
}

// Render Admin Console Views & Analytics
function renderAdminViews() {
    document.getElementById('stat-emp-count').innerText = employees.length;
    
    const todayStr = getLocalDateKey(new Date());
    const todayLogs = attendanceLogs.filter(l => l.date === todayStr);
    document.getElementById('stat-checkin-count').innerText = todayLogs.length;

    const pendingLeaves = leaveRequests.filter(l => l.status === 'Pending');
    document.getElementById('stat-leave-count').innerText = pendingLeaves.length;

    // Render Attendance & Selfies Table
    const attBody = document.getElementById('attendance-table-body');
    if (attendanceLogs.length === 0) {
        attBody.innerHTML = '<tr><td colspan="6" class="p-3 text-center text-slate-400">No check-ins recorded.</td></tr>';
    } else {
        attBody.innerHTML = attendanceLogs.map(l => `
            <tr>
                <td class="p-2"><img src="${l.selfie}" class="w-10 h-10 object-cover rounded border border-slate-300"></td>
                <td class="p-2 text-slate-500">${l.time} (${l.date})</td>
                <td class="p-2 font-medium">${l.name}</td>
                <td class="p-2">${l.phone}</td>
                <td class="p-2">${l.dept}</td>
                <td class="p-2 font-mono">${l.distance}</td>
            </tr>
        `).join('');
    }

    // Render Leave Management Table
    const leaveBody = document.getElementById('leave-table-body');
    if (leaveRequests.length === 0) {
        leaveBody.innerHTML = '<tr><td colspan="6" class="p-3 text-center text-slate-400">No leave requests found.</td></tr>';
    } else {
        leaveBody.innerHTML = leaveRequests.map(r => `
            <tr>
                <td class="p-2 font-medium">${r.empId}</td>
                <td class="p-2">${r.type}</td>
                <td class="p-2 text-slate-500">${r.start} to ${r.end}</td>
                <td class="p-2">${r.reason}</td>
                <td class="p-2 font-semibold ${r.status === 'Approved' ? 'text-emerald-700' : r.status === 'Rejected' ? 'text-red-600' : 'text-amber-600'}">${r.status}</td>
                <td class="p-2">
                    ${r.status === 'Pending' ? `
                        <button onclick="updateLeaveStatus('${r.id}', 'Approved')" class="text-xs bg-emerald-700 text-white px-2 py-0.5 rounded mr-1">Approve</button>
                        <button onclick="updateLeaveStatus('${r.id}', 'Rejected')" class="text-xs bg-red-600 text-white px-2 py-0.5 rounded">Reject</button>
                    ` : '-'}
                </td>
            </tr>
        `).join('');
    }

    // Render Department Chart
    renderChart();
}

// Update Leave Status
function updateLeaveStatus(id, newStatus) {
    const item = leaveRequests.find(l => l.id === id);
    if (item) {
        item.status = newStatus;
        localStorage.setItem('office_leaves', JSON.stringify(leaveRequests));
        renderAdminViews();
    }
}

// Render Chart.js Analytics
function renderChart() {
    const ctx = document.getElementById('deptChart');
    if (!ctx) return;

    const deptCounts = {};
    employees.forEach(e => {
        deptCounts[e.dept] = (deptCounts[e.dept] || 0) + 1;
    });

    const labels = Object.keys(deptCounts);
    const data = Object.values(deptCounts);

    if (deptChartInstance) {
        deptChartInstance.destroy();
    }

    deptChartInstance = new Chart(ctx, {
        type: 'pie',
        data: {
            labels: labels.length ? labels : ['No Data'],
            datasets: [{
                data: data.length ? data : [1],
                backgroundColor: ['#0f172a', '#334155', '#64748b', '#94a3b8', '#cbd5e1']
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false
        }
    });
}
