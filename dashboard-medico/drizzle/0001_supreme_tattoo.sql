CREATE TABLE `atendimentos` (
	`id` varchar(64) NOT NULL,
	`pacienteNomeEncrypted` text,
	`pacienteCpfEncrypted` text,
	`pacienteTelefoneEncrypted` text,
	`pacienteEmailEncrypted` text,
	`pacienteNascimentoEncrypted` text,
	`doencasEncrypted` text,
	`status` enum('FILA','EM_ATENDIMENTO','APROVADO','RECUSADO') NOT NULL DEFAULT 'FILA',
	`pagamento` boolean NOT NULL DEFAULT false,
	`pagamentoEm` timestamp,
	`emAtendimentoPor` varchar(64),
	`emAtendimentoDesde` timestamp,
	`lockedUntil` timestamp,
	`tentativasLock` int DEFAULT 0,
	`finalizadoEm` timestamp,
	`criadoEm` timestamp NOT NULL DEFAULT (now()),
	`atualizadoEm` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `atendimentos_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `prontuarios` (
	`id` int AUTO_INCREMENT NOT NULL,
	`atendimentoId` varchar(64) NOT NULL,
	`medicamentos` json,
	`orientacoes` text,
	`diagnostico` text,
	`observacoes` text,
	`receitaPdfUrl` varchar(500),
	`criadoEm` timestamp NOT NULL DEFAULT (now()),
	`atualizadoEm` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `prontuarios_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
ALTER TABLE `users` MODIFY COLUMN `role` enum('user','admin','medico') NOT NULL DEFAULT 'user';--> statement-breakpoint
ALTER TABLE `users` ADD `crm` varchar(20);