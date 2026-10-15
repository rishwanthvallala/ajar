import java.math.*;
import java.util.*;

public class Numbers {
    static long fib(int n) { return n < 2 ? n : fib(n - 1) + fib(n - 2); }
    public static void main(String[] args) {
        System.out.println(Math.sqrt(2) + " " + Math.pow(2, 10) + " " + Math.abs(-5.5) + " " + Math.round(2.5) + " " + Math.round(-2.5) + " " + Math.ceil(1.1) + " " + Math.floor(-1.1));
        System.out.println(Math.max(3, 7) + " " + Math.min(-1.0, 2.0) + " " + Math.hypot(3, 4) + " " + Math.toDegrees(Math.PI) + " " + Math.cbrt(27));
        System.out.println(Math.sin(1) + " " + Math.cos(1) + " " + Math.tan(1) + " " + Math.log(10) + " " + Math.exp(1) + " " + Math.log10(1000) + " " + Math.atan2(1, 1));
        BigInteger f = BigInteger.ONE;
        for (int i = 1; i <= 30; i++) f = f.multiply(BigInteger.valueOf(i));
        System.out.println("30! = " + f + " bits " + f.bitLength() + " mod " + f.mod(BigInteger.valueOf(1_000_007)));
        System.out.println(new BigInteger("123456789012345678901234567890").pow(2) + " " + BigInteger.TWO.pow(100).isProbablePrime(10) + " " + new BigInteger("170141183460469231731687303715884105727").isProbablePrime(20));
        BigDecimal a = new BigDecimal("10.25"), b = new BigDecimal("3");
        System.out.println(a.add(b) + " " + a.multiply(b) + " " + a.divide(b, 5, RoundingMode.HALF_UP) + " " + a.setScale(1, RoundingMode.HALF_EVEN) + " " + new BigDecimal("1.10").stripTrailingZeros());
        Random rnd = new Random(12345);
        System.out.println(rnd.nextInt(100) + " " + rnd.nextInt(100) + " " + rnd.nextDouble() + " " + rnd.nextLong() + " " + rnd.nextBoolean() + " " + rnd.nextGaussian());
        System.out.println("fib(25) = " + fib(25));
        long sum = 0;
        for (int i = 0; i < 3_000_000; i++) sum += i % 7 * (i & 3);
        System.out.println("loop " + sum);
        System.out.println(Integer.bitCount(255) + " " + Long.numberOfTrailingZeros(64) + " " + Integer.reverse(1) + " " + Integer.compare(3, 5) + " " + Character.getNumericValue('9'));
        System.out.println((byte) 200 + " " + (short) 70000 + " " + (int) 3.99 + " " + (int) -3.99 + " " + (long) 1e19 + " " + (int) Double.NaN + " " + (char) 66 + " " + 07 + 0x1F + 0b101);
        System.out.println(Float.MIN_VALUE + " " + Double.MAX_VALUE + " " + 1.0f / 3 + " " + 2.0 / 3 + " " + (0.1f + 0.2f) + " " + 1234567.0 + " " + 12345678.9 + " " + 0.00001);
        System.out.println(String.valueOf(1e-5) + " " + 123e10 + " " + (double) Long.MAX_VALUE + " " + Math.ulp(1.0));
        try { Integer.parseInt("abc"); } catch (NumberFormatException e) { System.out.println("NFE: " + e.getMessage()); }
        try { System.out.println(1 / 0); } catch (ArithmeticException e) { System.out.println("AE: " + e.getMessage()); }
        System.out.println(Integer.toString(255, 16) + " " + Integer.parseInt("ff", 16) + " " + Long.toString(-255, 2) + " " + Integer.toOctalString(8));
    }
}
