import { test, expect } from '@playwright/test';
import { cargarEntornoE2E } from './entorno';
import { sinScrollHorizontal, soloEnIphone, tamanoTactil } from './ayudas';

/**
 * Contraseña inicial y cambio obligatorio.
 *
 * El usuario que crea el seed entra una vez con la contraseña que le pusieron
 * y tiene que elegir una propia antes de poder usar nada. La prueba trabaja
 * sobre un usuario aparte, creado y borrado acá, para no tocar el admin ni el
 * operador que comparten las demás pruebas.
 */
const NUEVO = {
  email: 'estrena@e2e.local',
  inicial: 'ContrasenaInicial1',
  propia: 'MiPropiaClave2026',
};

async function conPrisma<T>(fn: (prisma: import('@prisma/client').PrismaClient) => Promise<T>) {
  cargarEntornoE2E();
  const { PrismaClient } = await import('@prisma/client');
  const prisma = new PrismaClient();
  try {
    return await fn(prisma);
  } finally {
    await prisma.$disconnect();
  }
}

test.describe('cambio de contraseña', () => {
  test.beforeEach(async ({}, testInfo) => {
    soloEnIphone(test, testInfo.project.name);
    await conPrisma(async (prisma) => {
      const { hashPassword } = await import('../../src/lib/auth/password');
      const rol = await prisma.role.findFirstOrThrow({ where: { code: 'OPERADOR' } });
      const sucursal = await prisma.branch.findFirstOrThrow({ where: { code: 'DEVOTO' } });
      await prisma.user.deleteMany({ where: { email: NUEVO.email } });
      await prisma.user.create({
        data: {
          email: NUEVO.email,
          name: 'Marta Estrena',
          passwordHash: await hashPassword(NUEVO.inicial),
          roleId: rol.id,
          branchId: sucursal.id,
          mustChangePassword: true,
        },
      });
    });
  });

  test.afterEach(async ({}, testInfo) => {
    if (testInfo.project.name !== 'iphone') return;
    await conPrisma(async (prisma) => {
      await prisma.user.deleteMany({ where: { email: NUEVO.email } });
    });
  });

  async function entrar(page: import('@playwright/test').Page, password: string) {
    await page.goto('/ingresar');
    await page.getByLabel('Correo').fill(NUEVO.email);
    await page.getByLabel('Contraseña').fill(password);
    await page.getByRole('button', { name: 'Ingresar' }).click();
  }

  test('con la contraseña inicial no se llega a ninguna pantalla', async ({ page }) => {
    await entrar(page, NUEVO.inicial);
    await expect(page).toHaveURL(/\/cambiar-contrasena/);

    // Ni yendo a mano a otra ruta: el corte está en el servidor.
    for (const ruta of ['/', '/comprobantes', '/nueva-compra', '/pagos']) {
      await page.goto(ruta);
      await expect(page).toHaveURL(/\/cambiar-contrasena/);
    }
  });

  test('no acepta una contraseña débil, repetida ni mal confirmada', async ({ page }) => {
    await entrar(page, NUEVO.inicial);
    await expect(page).toHaveURL(/\/cambiar-contrasena/);

    const error = page.locator('.mensaje-error');

    // Las dos nuevas no coinciden.
    await page.getByLabel('Contraseña actual').fill(NUEVO.inicial);
    await page.getByLabel('Contraseña nueva').fill(NUEVO.propia);
    await page.getByLabel('Repetir la nueva').fill('OtraDistinta1');
    await page.getByRole('button', { name: 'Guardar contraseña' }).click();
    await expect(error).toHaveText('Las dos contraseñas nuevas no coinciden.');

    // Demasiado corta.
    await page.getByLabel('Contraseña actual').fill(NUEVO.inicial);
    await page.getByLabel('Contraseña nueva').fill('corta1');
    await page.getByLabel('Repetir la nueva').fill('corta1');
    await page.getByRole('button', { name: 'Guardar contraseña' }).click();
    await expect(error).toContainText('al menos 10 caracteres');

    // Sin números.
    await page.getByLabel('Contraseña actual').fill(NUEVO.inicial);
    await page.getByLabel('Contraseña nueva').fill('solamenteletras');
    await page.getByLabel('Repetir la nueva').fill('solamenteletras');
    await page.getByRole('button', { name: 'Guardar contraseña' }).click();
    await expect(error).toContainText('letras y números');

    // La misma de siempre no cuenta como cambio.
    await page.getByLabel('Contraseña actual').fill(NUEVO.inicial);
    await page.getByLabel('Contraseña nueva').fill(NUEVO.inicial);
    await page.getByLabel('Repetir la nueva').fill(NUEVO.inicial);
    await page.getByRole('button', { name: 'Guardar contraseña' }).click();
    await expect(error).toHaveText('La contraseña nueva tiene que ser distinta de la actual.');

    // Y sin la actual correcta no se cambia nada.
    await page.getByLabel('Contraseña actual').fill('esta-no-es-1');
    await page.getByLabel('Contraseña nueva').fill(NUEVO.propia);
    await page.getByLabel('Repetir la nueva').fill(NUEVO.propia);
    await page.getByRole('button', { name: 'Guardar contraseña' }).click();
    await expect(error).toHaveText('La contraseña actual no es correcta.');

    // La marca sigue puesta después de todos los intentos fallidos.
    const marca = await conPrisma((prisma) =>
      prisma.user.findUniqueOrThrow({
        where: { email: NUEVO.email },
        select: { mustChangePassword: true },
      }),
    );
    expect(marca.mustChangePassword).toBe(true);
  });

  test('cambiada la contraseña se entra normalmente, y sólo con la nueva', async ({ page }) => {
    await entrar(page, NUEVO.inicial);
    await expect(page).toHaveURL(/\/cambiar-contrasena/);

    await page.getByLabel('Contraseña actual').fill(NUEVO.inicial);
    await page.getByLabel('Contraseña nueva').fill(NUEVO.propia);
    await page.getByLabel('Repetir la nueva').fill(NUEVO.propia);
    await page.getByRole('button', { name: 'Guardar contraseña' }).click();

    // Queda adentro, sin tener que volver a escribir la contraseña.
    await expect(page.getByRole('heading', { level: 1 })).toContainText('Hola, Marta');
    await expect(page).toHaveURL(/127\.0\.0\.1:3100\/?$/);

    // Y la marca se bajó: la pantalla ya no lo intercepta.
    await page.goto('/comprobantes');
    await expect(page).toHaveURL(/\/comprobantes/);

    // Sale, y la contraseña vieja ya no sirve.
    await page.goto('/mas');
    await page.getByRole('button', { name: 'Cerrar sesión' }).click();
    await entrar(page, NUEVO.inicial);
    await expect(page.locator('.mensaje-error')).toHaveText(
      'El correo o la contraseña no son correctos.',
    );

    // La nueva sí, y entra derecho a la aplicación.
    await entrar(page, NUEVO.propia);
    await expect(page.getByRole('heading', { level: 1 })).toContainText('Hola, Marta');
  });

  test('queda registrado en la auditoría quién cambió su contraseña', async ({ page }) => {
    await entrar(page, NUEVO.inicial);
    await page.getByLabel('Contraseña actual').fill(NUEVO.inicial);
    await page.getByLabel('Contraseña nueva').fill(NUEVO.propia);
    await page.getByLabel('Repetir la nueva').fill(NUEVO.propia);
    await page.getByRole('button', { name: 'Guardar contraseña' }).click();
    await expect(page.getByRole('heading', { level: 1 })).toContainText('Hola, Marta');

    const registros = await conPrisma((prisma) =>
      prisma.auditLog.findMany({
        where: { action: 'usuario.contrasena_cambiada' },
        include: { user: true },
      }),
    );
    expect(registros.some((r) => r.user?.email === NUEVO.email)).toBe(true);
  });

  test('la pantalla entra bien en el iPhone', async ({ page }) => {
    await entrar(page, NUEVO.inicial);
    await expect(page).toHaveURL(/\/cambiar-contrasena/);
    await sinScrollHorizontal(page);
    await tamanoTactil(page, 'button[type="submit"]');
  });
});
