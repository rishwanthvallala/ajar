// Compile-time constants: javac folds these itself, so a compiler that computes
// them differently from HotSpot's javac writes different class files.
public class Constants {
    static final double D1 = 1e23, D2 = 0x1.8p1, D3 = 4.9e-324, D4 = 1.7976931348623157e308, D5 = 2.2250738585072014E-308;
    static final double D6 = 0.1 + 0.2, D7 = 1.0 / 3, D8 = 100.0 / 7, D9 = 9007199254740993.0, D10 = 123456789.123456789e-20;
    static final float F1 = 16777217f, F2 = 1.17549435E-38f, F3 = 0.1f + 0.2f, F4 = 3.4028235e38f, F5 = 1.4e-45f, F6 = 0x1.fffffeP+127f;
    static final String S1 = "x" + 5e-324, S2 = "" + 1e-5, S3 = "" + 100.0 / 3, S4 = "" + (float) 0.1, S5 = "" + 1e21 + "|" + 1e-3;
    static final String S6 = "" + 123456789012.0 + " " + 1.0E7 + " " + 9999999.0 + " " + 0.001 + " " + 0.0001 + " " + (float) 1e10;
    static final double R1 = 2147483647 % 9.268e-237, R2 = 5.5 % 2.25, R3 = -7.5 % 2.0, R4 = 1.0 % 0.0;
    static final float R5 = 10.5f % 3.2f;
    static final double Z1 = -0.0, Z2 = 0.0 * -1, Z3 = 1 / -0.0, Z4 = -(0.0);
    static final long L1 = Long.MIN_VALUE / -1, L2 = Long.MIN_VALUE % -1, L3 = Long.MAX_VALUE + 1, L4 = 1L << 63, L5 = -17L >> 2, L6 = -17L >>> 60;
    static final int I1 = Integer.MIN_VALUE / -1, I2 = Integer.MIN_VALUE % -1, I3 = 7 / -2, I4 = -7 % 3, I5 = 1 << 33, I6 = (int) 3.99e10, I7 = (int) Double.NaN;
    static final char C1 = 'A' + 2, C2 = (char) 65536, C3 = 'é';
    static final byte B1 = (byte) 200;
    static final short SH = (short) 70000;
    static final boolean BO = 0.1 + 0.2 == 0.3;
    static final String T1 = """
        line one\s
        line two \
        continued
          indented\ttab "quotes" \""" end
        """;

    public static void main(String[] args) {
        int 数 = 3;
        String café = "naïve";
        double ñandú = 2.5;
        System.out.println(D1 + " " + D2 + " " + D3 + " " + D4 + " " + D5);
        System.out.println(D6 + " " + D7 + " " + D8 + " " + D9 + " " + D10);
        System.out.println(F1 + " " + F2 + " " + F3 + " " + F4 + " " + F5 + " " + F6);
        System.out.println(S1 + " | " + S2 + " | " + S3 + " | " + S4 + " | " + S5);
        System.out.println(S6);
        System.out.println(R1 + " " + R2 + " " + R3 + " " + R4 + " " + R5);
        System.out.println(Z1 + " " + Z2 + " " + Z3 + " " + Z4 + " " + (1 / Z4));
        System.out.println(L1 + " " + L2 + " " + L3 + " " + L4 + " " + L5 + " " + L6);
        System.out.println(I1 + " " + I2 + " " + I3 + " " + I4 + " " + I5 + " " + I6 + " " + I7);
        System.out.println(C1 + " " + (int) C2 + " " + C3 + " " + B1 + " " + SH + " " + BO);
        System.out.print(T1);
        System.out.println(数 + " " + café + " " + ñandú);
        System.out.println(Double.toString(1e-7) + " " + Float.toString(1.0e-10f) + " " + Double.parseDouble("0x1p-1074") + " " + Float.parseFloat("16777217"));
    }
}
