
# Script de Teste de Rotas - Doctor Prescreve
# Execute no PowerShell: .\test-routes.ps1

$baseUrl = "http://localhost:3000" # Ajuste se o seu servidor estiver em outra porta

function Test-Endpoint {
    param($Method, $Path, $Body, $Title)
    Write-Host "`n--- $Title ---" -ForegroundColor Cyan
    try {
        $params = @{
            Uri = "$baseUrl$Path"
            Method = $Method
            ContentType = "application/json"
        }
        if ($Body) { $params.Body = ($Body | ConvertTo-Json -Depth 10) }
        
        $start = Get-Date
        $response = Invoke-RestMethod @params
        $end = Get-Date
        $duration = ($end - $start).TotalMilliseconds
        
        Write-Host "✅ Sucesso ($($duration)ms)" -ForegroundColor Green
        $response | ConvertTo-Json -Depth 10
    } catch {
        Write-Host "❌ Falha: $($_.Exception.Message)" -ForegroundColor Red
        if ($_.Exception.Response) {
            $reader = New-Object System.IO.StreamReader($_.Exception.Response.GetResponseStream())
            Write-Host "Detalhes: $($reader.ReadToEnd())" -ForegroundColor Yellow
        }
    }
}

Write-Host "🚀 Iniciando Teste de Rotas do Doctor Prescreve" -ForegroundColor White -BackgroundColor Blue

# 1. Health Check
Test-Endpoint -Method GET -Path "/api/health" -Title "1. Health Check do Sistema"

# 2. Simular Entrada do Typebot (Triagem)
$atendimentoId = "test-" + (Get-Random)
$triagemBody = @{
    id = $atendimentoId
    paciente = @{
        nome = "Paciente Teste PowerShell"
        cpf = "12345678901"
        telefone = "5511999999999"
        email = "teste@exemplo.com"
        data_nascimento = "1990-01-01"
    }
    triagem = @{
        medicamento = "Losartana 50mg"
        tempo_uso = "Mais de 6 meses"
        sinais_alerta = "NAO"
        receita_vencida = "NAO"
    }
    elegivel = $true
    status = "AGUARDANDO_PAGAMENTO"
}
Test-Endpoint -Method POST -Path "/api/webhook/atualizar-status" -Body $triagemBody -Title "2. Simular Entrada de Triagem (Typebot)"

# 3. Simular Pagamento Aprovado (Stripe/N8N)
$pagamentoBody = @{
    atendimentoId = $atendimentoId
    status = "FILA"
}
Test-Endpoint -Method POST -Path "/api/webhook/atualizar-status" -Body $pagamentoBody -Title "3. Simular Pagamento Aprovado (Stripe)"

# 4. Verificar Atendimento na Fila
Test-Endpoint -Method GET -Path "/api/atendimentos/fila" -Title "4. Verificar Atendimento na Fila"

Write-Host "`n🏁 Testes concluídos!" -ForegroundColor White -BackgroundColor Blue
