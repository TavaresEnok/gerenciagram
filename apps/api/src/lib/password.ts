import { hash, verify } from '@node-rs/argon2';

/**
 * Hash de senha com argon2id (SPEC seção 10).
 *
 * Parâmetros seguindo a recomendação do OWASP Password Storage Cheat Sheet:
 * 19 MiB de memória, 2 iterações, paralelismo 1. Argon2id resiste tanto a
 * ataque por GPU quanto a side-channel, que é o motivo de ser preferido ao
 * argon2i e ao argon2d isolados.
 *
 * Usamos @node-rs/argon2 (binário pré-compilado) em vez do pacote `argon2`
 * nativo: evita exigir toolchain de C++ para instalar o projeto no Windows.
 */

const OPTIONS = {
  memoryCost: 19_456, // 19 MiB
  timeCost: 2,
  parallelism: 1,
} as const;

export async function hashPassword(password: string): Promise<string> {
  return hash(password, OPTIONS);
}

export async function verifyPassword(hashed: string, password: string): Promise<boolean> {
  try {
    return await verify(hashed, password, OPTIONS);
  } catch {
    // Hash malformado no banco não deve derrubar o login com 500 — é um
    // "não confere" do ponto de vista de quem tenta entrar.
    return false;
  }
}

/**
 * Política mínima de senha. Comprimento pesa mais que composição — exigir
 * símbolo empurra o usuário para "Senha1!" e não aumenta a entropia real.
 */
export interface PasswordCheck {
  ok: boolean;
  problems: string[];
}

const COMMON_PASSWORDS = new Set([
  '12345678',
  '123456789',
  'senha123',
  'password',
  'password1',
  'qwerty123',
  'abc12345',
  'brasil123',
  'admin123',
  'mudar123',
]);

export function checkPasswordStrength(password: string, email?: string): PasswordCheck {
  const problems: string[] = [];

  if (password.length < 12) {
    problems.push('A senha precisa ter pelo menos 12 caracteres.');
  }
  if (password.length > 200) {
    problems.push('A senha pode ter no máximo 200 caracteres.');
  }
  if (COMMON_PASSWORDS.has(password.toLowerCase())) {
    problems.push('Esta senha é muito comum. Escolha outra.');
  }
  if (email) {
    const localPart = email.split('@')[0]?.toLowerCase();
    if (localPart && localPart.length >= 3 && password.toLowerCase().includes(localPart)) {
      problems.push('A senha não pode conter o seu e-mail.');
    }
  }
  if (/^(.)\1+$/.test(password)) {
    problems.push('A senha não pode ser um único caractere repetido.');
  }

  return { ok: problems.length === 0, problems };
}
