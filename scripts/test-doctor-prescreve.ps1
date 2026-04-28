# Doctor Prescreve - Test Script (PowerShell)
Write-Host "🧪 DOCTOR PRESCREVE - WORKFLOW VALIDATION TEST" -ForegroundColor Cyan
Write-Host ""

$N8N_URL = "https://n8n-node-production-f844.up.railway.app"
$BACKEND_URL = "https://medico-prescreve-backend-production.up.railway.app"

Write-Host "[1] Testando n8n..." -ForegroundColor Yellow
try {
    $response = Invoke-WebRequest -Uri $N8N_URL -TimeoutSec 10 -SkipCertificateCheck
    Write-Host "    ✅ n8n online (HTTP $($response.StatusCode))" -ForegroundColor Green
} catch {
    Write-Host "    ❌ n8n offline" -ForegroundColor Red
}

Write-Host ""
Write-Host "[2] Testando backend..." -ForegroundColor Yellow
try {
    $response = Invoke-WebRequest -Uri "$BACKEND_URL/healthz" -TimeoutSec 10 -SkipCertificateCheck
    Write-Host "    ✅ Backend online (HTTP $($response.StatusCode))" -ForegroundColor Green
} catch {
    Write-Host "    ❌ Backend offline" -ForegroundColor Red
}

Write-Host ""
Write-Host "[3] Criando atendimento..." -ForegroundColor Yellow
$body = '{"paciente":{"nome":"Teste PowerShell","telefone":"11999999999"},"triagem":{"doencas":["hipertensao"]}}'
try {
    $result = Invoke-RestMethod -Uri "$BACKEND_URL/api/webhook/triagem" -Method POST -Body $body -ContentType "application/json"
    Write-Host "    ✅ Atendimento criado!" -ForegroundColor Green
    Write-Host "    📋 ID: $($result.id)" -ForegroundColor Cyan
} catch {
    Write-Host "    ❌ Erro ao criar atendimento" -ForegroundColor Red
}

Write-Host ""
Write-Host "✅ Teste concluído!" -ForegroundColor Green
