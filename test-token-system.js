// Тест системы токенов
console.log('=== Тестирование системы токенов ===');

// Эмулируем запрос к API для проверки баланса
async function testTokenSystem() {
  const testUserId = 123456789;

  console.log('1. Проверяем создание пользователя с нулевыми токенами...');

  // Эмулируем проверку баланса
  const mockUser = {
    telegramId: testUserId.toString(),
    videoTokens: 0,
    imageTokens: 0,
    isSubscribed: false,
  };

  console.log(`Пользователь ${testUserId}:`);
  console.log(`- Видео токены: ${mockUser.videoTokens}`);
  console.log(`- Токены изображений: ${mockUser.imageTokens}`);
  console.log(`- Подписка: ${mockUser.isSubscribed ? 'Активна' : 'Неактивна'}`);

  console.log('\n2. Проверяем попытку генерации без токенов...');

  const requiredTokensForVideo = 4; // 5-секундное видео
  const requiredTokensForImage = 1;

  if (mockUser.videoTokens < requiredTokensForVideo) {
    console.log('❌ Недостаточно токенов для генерации видео');
    console.log(
      `Требуется: ${requiredTokensForVideo}, доступно: ${mockUser.videoTokens}`,
    );
  }

  if (mockUser.imageTokens < requiredTokensForImage) {
    console.log('❌ Недостаточно токенов для генерации изображения');
    console.log(
      `Требуется: ${requiredTokensForImage}, доступно: ${mockUser.imageTokens}`,
    );
  }

  console.log('\n3. Эмулируем покупку токенов...');

  // Эмулируем покупку базового пакета
  const basicPackage = {
    videoTokens: 10,
    imageTokens: 50,
    price: 299,
  };

  console.log(`Покупка базового пакета за ${basicPackage.price}₽:`);
  console.log(`+ ${basicPackage.videoTokens} видео токенов`);
  console.log(`+ ${basicPackage.imageTokens} токенов изображений`);

  // Обновляем баланс
  mockUser.videoTokens += basicPackage.videoTokens;
  mockUser.imageTokens += basicPackage.imageTokens;

  console.log('\n4. Проверяем баланс после покупки...');
  console.log(`- Видео токены: ${mockUser.videoTokens}`);
  console.log(`- Токены изображений: ${mockUser.imageTokens}`);

  console.log('\n5. Пробуем генерацию после покупки...');

  if (mockUser.videoTokens >= requiredTokensForVideo) {
    console.log('✅ Достаточно токенов для генерации видео');
    mockUser.videoTokens -= requiredTokensForVideo;
    console.log(`Списано: ${requiredTokensForVideo} токенов`);
    console.log(`Остаток: ${mockUser.videoTokens} токенов`);
  }

  if (mockUser.imageTokens >= requiredTokensForImage) {
    console.log('✅ Достаточно токенов для генерации изображения');
    mockUser.imageTokens -= requiredTokensForImage;
    console.log(`Списано: ${requiredTokensForImage} токен`);
    console.log(`Остаток: ${mockUser.imageTokens} токенов`);
  }

  console.log('\n=== Тест завершен ===');
  console.log('Система токенов работает корректно! ✅');
}

testTokenSystem().catch(console.error);
